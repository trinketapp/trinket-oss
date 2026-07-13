var Boom     = require('@hapi/boom');
var JSZip    = require('jszip');
var fs       = require('fs');
var crypto   = require('crypto');
var request  = require('request');
var config   = require('config');
var Trinket  = require('../models/trinket');
var Course   = require('../models/course');
var Lesson   = require('../models/lesson');
var Material = require('../models/material');
var File     = require('../models/file');
var FileUtil = require('../util/file');

// Files inside a trinket folder that are not code
var NON_CODE_RE = /^(metadata\.json|instructions\.md)$|^assets\//;

// Matches trinket embed iframes from trinket.io or any local server.
// Group 1 = full iframe tag, group 2 = lang, group 3 = shortCode.
var TRINKET_EMBED_RE = /(<iframe[^>]+src=['"][^'"]*\/embed\/(\w+)\/([a-f0-9]{8,12})[^'"]*['"][^>]*>)/gi;

// Matches the embed src URL inside an iframe tag (any server), used to rewrite
// just the shortCode portion. Group 1 = lang, group 2 = shortCode.
var EMBED_URL_RE = /https?:\/\/[^\/'"]+\/embed\/(\w+)\/([a-f0-9]{8,12})/;

// Matches relative /api/files/ paths in markdown image links and HTML src attrs
var TRINKET_FILES_PATH_RE = /(?:\]\(|src=['"]?)(\/api\/files\/[^\s)"'>]+)/g;
var TRINKET_FILES_SOURCE  = 'https://trinket.io';

// ─── Trinket import ──────────────────────────────────────────────────────────

function readUploadedFile(payloadFile) {
  // With output:'file', Hapi writes the upload to a temp path and gives us {path, ...}
  var filePath = payloadFile && (payloadFile.path || payloadFile);
  if (!filePath) return Promise.reject(Boom.badRequest('no file uploaded'));
  return Promise.resolve(fs.readFileSync(filePath));
}

// Splits items into fixed-size chunks, runs finderFn on each sequentially, and
// concatenates the results. Keeps $in queries under backend limits.
function findInChunks(items, finderFn) {
  var CHUNK = 30;
  var chunks = [];
  for (var i = 0; i < items.length; i += CHUNK) {
    chunks.push(items.slice(i, i + CHUNK));
  }
  return chunks.reduce(function(chain, chunk) {
    return chain.then(function(acc) {
      return finderFn(chunk).then(function(found) { return acc.concat(found); });
    });
  }, Promise.resolve([]));
}

function importTrinkets(request, reply) {
  var userId  = request.user && request.user.id;
  var replace = request.payload.replace || false;

  return readUploadedFile(request.payload.file)
    .then(function(zipBuffer) { return JSZip.loadAsync(zipBuffer); })
    .then(function(zip) {
      var manifestFile = zip.file('manifest.json');
      if (!manifestFile) throw Boom.badRequest('zip does not contain manifest.json');

      return manifestFile.async('string').then(function(str) {
        var manifest;
        try { manifest = JSON.parse(str); } catch(e) { throw Boom.badRequest('manifest.json is not valid JSON'); }
        if (!Array.isArray(manifest.trinkets)) throw Boom.badRequest('manifest.json missing trinkets array');
        return { zip: zip, manifest: manifest };
      });
    })
    .then(function(ctx) {
      var results = { imported: 0, skipped: 0, failed: 0, mapping: {} };
      return ctx.manifest.trinkets.reduce(function(chain, entry) {
        return chain.then(function() {
          return importOneTrinket(ctx.zip, entry, userId, replace, results);
        });
      }, Promise.resolve()).then(function() { return results; });
    })
    .then(function(results) {
      // Patch any course materials that were waiting on these trinkets
      var patchTargets = Object.keys(results.mapping);
      return patchUnresolvedRefs(patchTargets, results.mapping).then(function(patched) {
        results.patched = patched;
        return request.success({ data: results });
      });
    })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      return request.fail({ error: err.message });
    });
}

function importOneTrinket(zip, entry, userId, replace, results) {
  var legacyShortCode = entry.shortCode;
  if (!legacyShortCode) return Promise.resolve();

  return Trinket.findByLegacyShortCode(legacyShortCode)
    .then(function(existing) {
      return readTrinketFromZip(zip, entry)
        .then(function(data) {
          if (!data) { results.failed++; return; }

          if (existing) {
            if (!replace) {
              results.skipped++;
              results.mapping[legacyShortCode] = existing.shortCode;
              return;
            }
            existing.name        = data.name;
            existing.description = data.description;
            existing.lang        = data.lang;
            existing.code        = data.code;
            existing.settings    = data.settings;
            return existing.save().then(function(saved) {
              results.updated = (results.updated || 0) + 1;
              results.mapping[legacyShortCode] = saved.shortCode;
            });
          }

          var trinket = new Trinket({
            name            : data.name,
            description     : data.description,
            lang            : data.lang,
            code            : data.code,
            settings        : data.settings,
            legacyShortCode : legacyShortCode,
            _owner          : userId,
            _creator        : userId
          });

          return trinket.save().then(function(saved) {
            results.imported++;
            results.mapping[legacyShortCode] = saved.shortCode;
          });
        })
        .catch(function(err) {
          console.error('Failed to import trinket', legacyShortCode, err.message);
          results.failed++;
        });
    });
}

function readTrinketFromZip(zip, entry) {
  var shortCode  = entry.shortCode;
  var folderPath = null;

  // Derive folder from file paths — export zip has no explicit directory entries.
  // Export format: {lang}/{sanitizedName}_{shortCode}/{file}
  var suffix = '_' + shortCode + '/';
  zip.forEach(function(relativePath) {
    if (folderPath) return;
    var idx = relativePath.indexOf(suffix);
    if (idx !== -1) {
      folderPath = relativePath.slice(0, idx + suffix.length);
    }
  });

  if (!folderPath) {
    console.warn('No folder found for legacy shortCode:', shortCode);
    return Promise.resolve(null);
  }

  var metaFile = zip.file(folderPath + 'metadata.json');
  if (!metaFile) {
    console.warn('No metadata.json at', folderPath);
    return Promise.resolve(null);
  }

  return metaFile.async('string').then(function(metaStr) {
    var meta;
    try { meta = JSON.parse(metaStr); } catch(e) { return null; }

    var codeFiles    = [];
    var codePromises = [];

    zip.forEach(function(relativePath, zipEntry) {
      if (zipEntry.dir) return;
      if (relativePath.indexOf(folderPath) !== 0) return;
      var localName = relativePath.slice(folderPath.length);
      if (!localName || NON_CODE_RE.test(localName)) return;
      codePromises.push(
        zipEntry.async('string').then(function(content) {
          codeFiles.push({ name: localName, content: content });
        })
      );
    });

    return Promise.all(codePromises).then(function() {
      return {
        name        : meta.name,
        description : meta.description,
        lang        : meta.lang || entry.lang,
        code        : codeFiles.length === 1 ? codeFiles[0].content : JSON.stringify(codeFiles),
        settings    : meta.settings
      };
    });
  });
}

// ─── Patch unresolved refs ───────────────────────────────────────────────────

// After trinkets are imported, find materials that had those legacyShortCodes
// in unresolvedLegacyRefs and rewrite the embed URLs to point to the local server.
function patchUnresolvedRefs(shortCodes, legacyMap) {
  if (!shortCodes.length) return Promise.resolve(0);
  var baseUrl = config.url;

  return findInChunks(shortCodes, function(chunk) {
    return Material.findByUnresolvedLegacyRefs(chunk);
  })
  .then(function(found) {
    // A material can match in multiple chunks (one per legacy ref), so dedup by _id.
    var seen = {};
    var materials = found.filter(function(m) {
      var key = String(m._id);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    if (!materials.length) return 0;

    return Promise.all(materials.map(function(material) {
      var originalContent = material.content;
      material.content = (material.content || '').replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
        if (legacyMap[sc]) {
          return iframeTag.replace(
            EMBED_URL_RE,
            baseUrl + '/embed/' + lang + '/' + legacyMap[sc]
          );
        }
        return full;
      });

      material.unresolvedLegacyRefs = (material.unresolvedLegacyRefs || []).filter(function(sc) {
        return !legacyMap[sc];
      });

      if (material.content === originalContent) return Promise.resolve();
      return material.save();
    })).then(function() { return materials.length; });
  });
}

// ─── Course import ───────────────────────────────────────────────────────────

// Detects a trinkets/manifest.json bundled anywhere in the zip (with or without
// an outer wrapper directory) and imports those trinkets before course creation.
// Uses replace=false so already-imported trinkets are skipped rather than
// overwritten.  Trinkets are owned by the importing user regardless of original
// ownership, making the import fully self-contained.
function autoImportBundledTrinkets(zip, userId) {
  var manifestEntry = null;
  zip.forEach(function(path) {
    if (!manifestEntry && /(?:^|\/)trinkets\/manifest\.json$/.test(path.replace(/\\/g, '/'))) {
      manifestEntry = zip.file(path);
    }
  });
  if (!manifestEntry) return Promise.resolve();

  return manifestEntry.async('string').then(function(str) {
    var manifest;
    try { manifest = JSON.parse(str); } catch(e) { return; }
    if (!Array.isArray(manifest.trinkets) || !manifest.trinkets.length) return;

    var results = { imported: 0, skipped: 0, failed: 0, mapping: {} };
    return manifest.trinkets.reduce(function(chain, entry) {
      return chain.then(function() {
        return importOneTrinket(zip, entry, userId, false, results);
      });
    }, Promise.resolve()).then(function() {
      console.log('course import: bundled trinkets —', results.imported, 'imported,',
        results.skipped, 'skipped,', results.failed, 'failed');
    });
  });
}

function importCourse(request, reply) {
  var force      = request.payload.force || false;
  var courseName = request.payload.name;
  var userId     = request.user && request.user.id;
  var user       = request.user;
  var courseZip;
  var globalSettings;

  return readUploadedFile(request.payload.file)
    .then(function(zipBuffer) { return JSZip.loadAsync(zipBuffer); })
    .then(function(zip) {
      courseZip = zip;
      return autoImportBundledTrinkets(zip, userId).then(function() {
        return parseCourseZip(zip);
      });
    })
    .then(function(parsed) {
      globalSettings = parsed.globalSettings;
      // Validate all trinket refs against legacyShortCode in DB
      return resolveAllRefs(parsed.chapters);
    })
    .then(function(result) {
      var chapters        = result.chapters;
      var missing         = result.missing;
      var legacyToTrinket = result.legacyToTrinket;

      if (missing.length && !force) {
        // Return warning so the caller can decide to force or cancel
        return request.success({
          data: {
            status  : 'missing_refs',
            missing : missing,
            message : missing.length + ' trinket(s) not yet imported. Import trinkets first, or re-submit with force=true to leave old URLs intact.'
          }
        });
      }

      // Create the course structure
      var warnings = [];
      return createCourseFromChapters(chapters, courseName, user, courseZip, legacyToTrinket, warnings, globalSettings)
        .then(function(course) {
          var data = {
            status    : 'ok',
            courseId  : course.id,
            slug      : course.slug,
            ownerSlug : user.username,
            url       : '/' + user.username + '/courses/' + course.slug
          };
          if (warnings.length) data.warnings = warnings;
          return request.success({ data: data });
        });
    })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      console.error('Course import error:', err);
      return request.fail({ error: err.message });
    });
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function parseCourseZip(zip) {
  // Detect outer wrapper directory, if present (some zip tools add one level).
  var outerDir = '';
  zip.forEach(function(relativePath) {
    if (outerDir) return;
    var parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 3 && /\.md$/i.test(parts[2])) outerDir = parts[0] + '/';
  });

  // New format: course.json manifest carries original names and defines order.
  var manifestEntry = zip.file(outerDir + 'course.json');
  if (manifestEntry) {
    return manifestEntry.async('string').then(function(str) {
      var manifest;
      try { manifest = JSON.parse(str); } catch(e) { throw Boom.badRequest('course.json is not valid JSON'); }
      if (!Array.isArray(manifest.lessons)) throw Boom.badRequest('course.json missing lessons array');

      var chapters = [];
      var promises = [];

      manifest.lessons.forEach(function(lessonMeta, lessonIdx) {
        var folderName = pad2(lessonIdx) + '-' + lessonMeta.slug;
        var chapter    = { folderName: folderName, lessonName: lessonMeta.name, isDraft: lessonMeta.isDraft || false, materials: [] };
        chapters.push(chapter);

        (lessonMeta.materials || []).forEach(function(matMeta, matIdx) {
          var filename = pad2(matIdx) + '-' + matMeta.slug + '.md';
          var entry    = zip.file(outerDir + folderName + '/' + filename);
          if (!entry) return;
          promises.push(entry.async('string').then(function(content) {
            chapter.materials.push({
              filename    : filename,
              materialName: matMeta.name,
              type        : matMeta.type || 'page',
              isDraft     : matMeta.isDraft || false,
              trinketMeta : matMeta.trinket,
              content     : content
            });
          }));
        });
      });

      return Promise.all(promises).then(function() {
        chapters.forEach(function(ch) {
          ch.materials.sort(function(a, b) { return a.filename < b.filename ? -1 : 1; });
        });
        return { chapters: chapters, globalSettings: manifest.globalSettings };
      });
    });
  }

  // Legacy format: no manifest — derive names from slugs, sort by filename.
  // Strips any leading numeric prefix (e.g. "01-") before slug→title conversion
  // so zips created by newer exporters still reconstruct readable names.
  var chapterMap = {};
  var promises   = [];

  zip.forEach(function(relativePath, zipEntry) {
    if (zipEntry.dir) return;

    var parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);

    var folderName, filename;
    if (parts.length === 2 && /\.md$/i.test(parts[1])) {
      folderName = parts[0];
      filename   = parts[1];
    } else if (parts.length === 3 && /\.md$/i.test(parts[2])) {
      folderName = parts[1];
      filename   = parts[2];
    } else {
      return;
    }

    if (!chapterMap[folderName]) {
      chapterMap[folderName] = { folderName: folderName, materials: [] };
    }

    var chapter = chapterMap[folderName];
    promises.push(
      zipEntry.async('string').then(function(content) {
        chapter.materials.push({ filename: filename, content: content });
      })
    );
  });

  return Promise.all(promises).then(function() {
    var chapters = Object.values(chapterMap).sort(function(a, b) {
      return a.folderName < b.folderName ? -1 : 1;
    });
    chapters.forEach(function(ch) {
      ch.materials.sort(function(a, b) { return a.filename < b.filename ? -1 : 1; });
    });
    // Legacy archives carry no manifest, so there is no globalSettings to restore.
    return { chapters: chapters, globalSettings: undefined };
  });
}

function resolveAllRefs(chapters) {
  // Find all unique legacy shortCodes referenced in all materials —
  // both from embed URLs in content and from assignment trinket metadata
  var allShortCodes = [];
  chapters.forEach(function(ch) {
    ch.materials.forEach(function(mat) {
      var match;
      var re = new RegExp(TRINKET_EMBED_RE.source, 'gi');
      while ((match = re.exec(mat.content)) !== null) {
        var sc = match[3];
        if (allShortCodes.indexOf(sc) < 0) allShortCodes.push(sc);
      }
      if (mat.trinketMeta && mat.trinketMeta.shortCode &&
          allShortCodes.indexOf(mat.trinketMeta.shortCode) < 0) {
        allShortCodes.push(mat.trinketMeta.shortCode);
      }
    });
  });

  if (!allShortCodes.length) {
    return Promise.resolve({ chapters: chapters, missing: [], legacyToTrinket: {} });
  }

  return findInChunks(allShortCodes, function(chunk) {
    return Trinket.findByLegacyShortCodes(chunk);
  })
    .then(function(trinkets) {
      var legacyMap      = {};
      var legacyToTrinket = {};
      trinkets.forEach(function(t) {
        legacyMap[t.legacyShortCode]       = t.shortCode;
        legacyToTrinket[t.legacyShortCode] = t;
      });

      var missing = allShortCodes.filter(function(sc) { return !legacyMap[sc]; });

      // Rewrite content with resolved refs
      var baseUrl = config.url;
      chapters.forEach(function(ch) {
        ch.materials.forEach(function(mat) {
          mat.unresolvedLegacyRefs = [];
          mat.content = mat.content.replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
            if (legacyMap[sc]) {
              // Replace only the shortCode portion of the src URL
              return iframeTag.replace(
                EMBED_URL_RE,
                baseUrl + '/embed/' + lang + '/' + legacyMap[sc]
              );
            } else {
              // Unresolved: keep original tag, track the old shortCode
              if (mat.unresolvedLegacyRefs.indexOf(sc) < 0) {
                mat.unresolvedLegacyRefs.push(sc);
              }
              return full;
            }
          });
        });
      });

      return { chapters: chapters, missing: missing, legacyToTrinket: legacyToTrinket };
    });
}

function createCourseFromChapters(chapters, courseName, user, zip, legacyToTrinket, warnings, globalSettings) {
  var baseName = courseName || 'Imported Course';
  var course = new Course({
    name      : baseName,
    _owner    : user.id,
    ownerSlug : user.username
  });
  course.setOwner(user);

  // Restore course-level settings from the archive manifest, if present.
  // Only apply provided keys so missing ones keep their schema defaults.
  if (globalSettings) {
    ['courseType', 'contentDefault', 'copyable'].forEach(function(key) {
      if (globalSettings[key] !== undefined) course.globalSettings[key] = globalSettings[key];
    });
  }

  function trySave(attempt) {
    if (attempt > 0) course.name = baseName + ' (' + (attempt + 1) + ')';
    return course.save().catch(function(err) {
      if (err.code === 11000 && attempt < 10) return trySave(attempt + 1);
      throw err;
    });
  }

  return trySave(0)
    .then(function(savedCourse) {
      return course.addUser(user, ['course-owner'])
        .then(function() { return savedCourse; });
    })
    .then(function(savedCourse) {
      // Create lessons sequentially to preserve chapter order
      return chapters.reduce(function(chain, chapter) {
        return chain.then(function(c) {
          return createLessonFromChapter(c, chapter, user, zip, legacyToTrinket, warnings);
        });
      }, Promise.resolve(savedCourse));
    });
}

function createLessonFromChapter(course, chapter, user, zip, legacyToTrinket, warnings) {
  var lessonName = chapter.lessonName || chapter.folderName.replace(/^\d+-/, '').replace(/[-_]/g, ' ');
  var lesson = new Lesson({ name: lessonName, isDraft: chapter.isDraft || false });
  lesson.setOwner(user);

  return lesson.save()
    .then(function(savedLesson) {
      // Add materials sequentially to preserve order
      return chapter.materials.reduce(function(chain, mat) {
        return chain.then(function() {
          return createMaterialFromFile(savedLesson, mat, user, zip, legacyToTrinket, warnings);
        });
      }, Promise.resolve())
      .then(function() {
        course.lessons.push(savedLesson.id);
        return course.save();
      });
    });
}

// Uploads a buffer to the S3 materials bucket and creates a File record.
// Returns the new /api/files/{id}/{filename} path, or null on any failure
// (callers decide how to fall back).
function uploadAssetBuffer(buffer, filename, contentType, user) {
  var ext       = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  var hash      = crypto.createHash('sha1').update(buffer).digest('hex');
  var container = config.aws.buckets.materials;
  var s3Key     = hash + (ext ? '.' + ext : '');
  var fileinfo  = { name: s3Key, contentType: contentType };

  return new Promise(function(resolve) {
    FileUtil._upload(buffer, container, true, fileinfo, function(uploadErr) {
      if (uploadErr) {
        console.warn('import: could not upload asset', filename, uploadErr.message);
        return resolve(null);
      }

      var file = new File({
        url  : container.host + '/' + s3Key,
        type : 'embed',
        name : filename,
        mime : contentType,
        hash : hash,
        size : buffer.length
      });
      file.setOwner(user);

      file.save().then(function(saved) {
        var slugBase = filename.lastIndexOf('.') > -1
          ? filename.substring(0, filename.lastIndexOf('.'))
          : filename;
        resolve('/api/files/' + saved.id + '/' + slugBase + (ext ? '.' + ext : ''));
      }).catch(function(saveErr) {
        console.warn('import: could not save File record', filename, saveErr.message);
        resolve(null);
      });
    });
  });
}

// Downloads one asset from trinket.io, uploads it to our S3 materials bucket,
// creates a File record, and returns the new /api/files/{id}/{filename} path.
// On any failure returns the absolute trinket.io URL so the import still completes.
function rehostAsset(relativePath, user) {
  var sourceUrl = TRINKET_FILES_SOURCE + relativePath;
  var filename  = relativePath.split('/').pop();
  var ext       = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  return new Promise(function(resolve) {
    request({ url: sourceUrl, encoding: null }, function(err, resp, body) {
      if (err || !body || resp.statusCode !== 200) {
        console.warn('import: could not fetch asset', sourceUrl, err || resp.statusCode);
        return resolve(sourceUrl);
      }
      var contentType = resp.headers['content-type'] || ('image/' + (ext || 'png'));
      uploadAssetBuffer(body, filename, contentType, user).then(function(newPath) {
        resolve(newPath || sourceUrl);
      });
    });
  });
}

// Reads an asset embedded in the zip's assets/ folder and re-hosts it on our
// S3.  Returns the new /api/files/{id}/{filename} path, or null if the upload
// fails (caller keeps the original path rather than falling through to trinket.io,
// since zip-embedded assets do not exist on trinket.io).
function rehostAssetFromZip(zipEntry, filename, user) {
  var ext         = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  var contentType = 'image/' + (ext || 'png');
  return zipEntry.async('nodebuffer').then(function(buffer) {
    return uploadAssetBuffer(buffer, filename, contentType, user);
  });
}

// Finds all /api/files/ references in content, re-hosts each asset on our S3,
// and returns the content with rewritten URLs.
// When zip is provided, checks assets/{id}/{filename} in the zip first before
// fetching from trinket.io (supports self-contained exports).
// Falls back to absolute trinket.io URLs when S3 is not configured.
function rehostImportedAssets(content, user, zip, warnings) {
  if (!content) return Promise.resolve(content);

  // Collect unique relative paths
  var paths = [];
  var match;
  var re = new RegExp(TRINKET_FILES_PATH_RE.source, 'g');
  while ((match = re.exec(content)) !== null) {
    var p = match[1];
    if (p && !paths.includes(p)) paths.push(p);
  }
  if (!paths.length) return Promise.resolve(content);

  // If S3 not configured, just make the URLs absolute so images aren't broken
  if (!config.features.assets) {
    var fallback = content.replace(new RegExp(TRINKET_FILES_PATH_RE.source, 'g'), function(full, p) {
      return full.replace(p, TRINKET_FILES_SOURCE + p);
    });
    return Promise.resolve(fallback);
  }

  return Promise.all(paths.map(function(p) {
    // /api/files/{id}/{filename}  →  assets/{id}/{filename} in zip
    var zipKey   = zip && p.replace(/^\/api\/files\//, 'assets/');
    var zipEntry = zipKey && zip.file(zipKey);
    if (zipEntry) {
      var filename = p.split('/').pop();
      return rehostAssetFromZip(zipEntry, filename, user).then(function(newPath) {
        if (newPath) return { old: p, new: newPath };
        // Upload failed — fall back to absolute trinket.io URL so the path at least
        // doesn't reference a non-existent local file record
        console.warn('import: zip asset upload failed, using trinket.io fallback for', p);
        return { old: p, new: TRINKET_FILES_SOURCE + p };
      });
    }
    return rehostAsset(p, user).then(function(newPath) { return { old: p, new: newPath }; });
  })).then(function(replacements) {
    if (warnings) {
      var fallbacks = replacements.filter(function(r) {
        return r.new && r.new.indexOf(TRINKET_FILES_SOURCE) === 0;
      });
      if (fallbacks.length) {
        warnings.push(fallbacks.length + ' image(s) could not be re-hosted and still link to trinket.io — they may break after trinket.io shuts down.');
      }
    }
    return replacements.reduce(function(c, r) {
      return c.split(r.old).join(r.new);
    }, content);
  });
}

function createMaterialFromFile(lesson, matFile, user, zip, legacyToTrinket, warnings) {
  var name = matFile.materialName || matFile.filename.replace(/\.md$/i, '').replace(/^\d+-/, '').replace(/[-_]/g, ' ');
  var type = matFile.type || 'page';

  return rehostImportedAssets(matFile.content, user, zip, warnings).then(function(content) {
    var material = new Material({
      name    : name,
      content : content,
      type    : type,
      _owner  : user.id,
      isDraft : matFile.isDraft || false,
      unresolvedLegacyRefs : matFile.unresolvedLegacyRefs || []
    });
    material.setOwner(user);

    if (type === 'assignment' && matFile.trinketMeta && legacyToTrinket) {
      var tm       = matFile.trinketMeta;
      var trinket  = legacyToTrinket[tm.shortCode];
      if (trinket) {
        material.trinket = {
          trinketId         : trinket.id,
          name              : trinket.name,
          shortCode         : trinket.shortCode,
          lang              : trinket.lang,
          submissionsDue    : tm.submissionsDue,
          submissionsCutoff : tm.submissionsCutoff,
          availableOn       : tm.availableOn,
          hideAfter         : tm.hideAfter
        };
      } else {
        console.warn('import: no trinket found for assignment shortCode', tm.shortCode);
      }
    }

    return material.save().then(function(savedMaterial) {
      lesson.materials.push(savedMaterial.id);
      return lesson.save();
    });
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  importTrinkets : importTrinkets,
  importCourse   : importCourse
};
