var Boom     = require('@hapi/boom');
var JSZip    = require('jszip');
var fs       = require('fs');
var config   = require('config');
var mongoose = require('mongoose');
var Trinket  = require('../models/trinket');
var Course   = require('../models/course');
var Lesson   = require('../models/lesson');
var Material = require('../models/material');

// Files inside a trinket folder that are not code
var NON_CODE_RE = /^(metadata\.json)$|^assets\//;

// Matches <iframe src="https://trinket.io/embed/{lang}/{shortCode}...">
var TRINKET_EMBED_RE = /(<iframe[^>]+src=['"]https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})[^'"]*['"][^>]*>)/gi;

// ─── Trinket import ──────────────────────────────────────────────────────────

function readUploadedFile(payloadFile) {
  var filePath = payloadFile && (payloadFile.path || payloadFile);
  if (!filePath) return Promise.reject(Boom.badRequest('no file uploaded'));
  return Promise.resolve(fs.readFileSync(filePath));
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

  return mongoose.model('Snippet').findOne({ legacyShortCode: legacyShortCode }).exec()
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
            existing.name     = data.name;
            existing.lang     = data.lang;
            existing.code     = data.code;
            existing.settings = data.settings;
            return existing.save().then(function(saved) {
              results.updated = (results.updated || 0) + 1;
              results.mapping[legacyShortCode] = saved.shortCode;
            });
          }

          var trinket = new Trinket({
            name            : data.name,
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

  // Export format: {lang}/{sanitizedName}_{shortCode}/{file}
  // No explicit directory entries, so derive folder from file paths.
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
        name     : meta.name,
        lang     : meta.lang || entry.lang,
        code     : codeFiles.length === 1 ? codeFiles[0].content : JSON.stringify(codeFiles),
        settings : meta.settings
      };
    });
  });
}

// ─── Patch unresolved refs ───────────────────────────────────────────────────

// After trinkets are imported, find materials that referenced those legacy short
// codes in unresolvedLegacyRefs and rewrite the embed URLs to point here.
function patchUnresolvedRefs(shortCodes, legacyMap) {
  if (!shortCodes.length) return Promise.resolve(0);
  var baseUrl = config.url;

  return mongoose.model('Material').find({ unresolvedLegacyRefs: { $in: shortCodes } }).exec()
    .then(function(materials) {
      if (!materials.length) return 0;

      return Promise.all(materials.map(function(material) {
        var originalContent = material.content;
        material.content = (material.content || '').replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
          if (legacyMap[sc]) {
            return iframeTag.replace(
              /https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})/,
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

function importCourse(request, reply) {
  var force      = request.payload.force || false;
  var courseName = request.payload.name;
  var userId     = request.user && request.user.id;
  var user       = request.user;

  return readUploadedFile(request.payload.file)
    .then(function(zipBuffer) { return JSZip.loadAsync(zipBuffer); })
    .then(function(zip) {
      return parseCourseZip(zip);
    })
    .then(function(chapters) {
      return resolveAllRefs(chapters);
    })
    .then(function(result) {
      var chapters = result.chapters;
      var missing  = result.missing;

      if (missing.length && !force) {
        return request.success({
          data: {
            status  : 'missing_refs',
            missing : missing,
            message : missing.length + ' trinket(s) not yet imported. Import trinkets first, or re-submit with force=true to leave old URLs intact.'
          }
        });
      }

      return createCourseFromChapters(chapters, courseName, user)
        .then(function(course) {
          return request.success({ data: {
            status    : 'ok',
            courseId  : course.id,
            slug      : course.slug,
            ownerSlug : user.username,
            url       : '/' + user.username + '/courses/' + course.slug
          }});
        });
    })
    .catch(function(err) {
      if (err.isBoom) return request.fail(err);
      console.error('Course import error:', err);
      return request.fail({ error: err.message });
    });
}

function parseCourseZip(zip) {
  // Handles both flat (folder/file.md) and zips with an outer directory
  // (outer/folder/file.md — outer dir is stripped automatically).
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
      ch.materials.sort(function(a, b) {
        return a.filename < b.filename ? -1 : 1;
      });
    });
    return chapters;
  });
}

function resolveAllRefs(chapters) {
  var allShortCodes = [];
  chapters.forEach(function(ch) {
    ch.materials.forEach(function(mat) {
      var match;
      TRINKET_EMBED_RE.lastIndex = 0;
      while ((match = TRINKET_EMBED_RE.exec(mat.content)) !== null) {
        var sc = match[3];
        if (allShortCodes.indexOf(sc) < 0) allShortCodes.push(sc);
      }
    });
  });

  if (!allShortCodes.length) {
    return Promise.resolve({ chapters: chapters, missing: [] });
  }

  return mongoose.model('Snippet').find({ legacyShortCode: { $in: allShortCodes } }).exec()
    .then(function(trinkets) {
      var legacyMap = {};
      trinkets.forEach(function(t) { legacyMap[t.legacyShortCode] = t.shortCode; });

      var missing = allShortCodes.filter(function(sc) { return !legacyMap[sc]; });
      var baseUrl = config.url;

      chapters.forEach(function(ch) {
        ch.materials.forEach(function(mat) {
          mat.unresolvedLegacyRefs = [];
          mat.content = mat.content.replace(TRINKET_EMBED_RE, function(full, iframeTag, lang, sc) {
            if (legacyMap[sc]) {
              return iframeTag.replace(
                /https?:\/\/trinket\.io\/embed\/(\w+)\/([a-f0-9]{8,12})/,
                baseUrl + '/embed/' + lang + '/' + legacyMap[sc]
              );
            } else {
              if (mat.unresolvedLegacyRefs.indexOf(sc) < 0) {
                mat.unresolvedLegacyRefs.push(sc);
              }
              return full;
            }
          });
        });
      });

      return { chapters: chapters, missing: missing };
    });
}

function createCourseFromChapters(chapters, courseName, user) {
  var course = new Course({
    name      : courseName || 'Imported Course',
    _owner    : user.id,
    ownerSlug : user.username
  });
  course.setOwner(user);

  return course.save()
    .then(function(savedCourse) {
      return course.addUser(user, ['course-owner'])
        .then(function() { return savedCourse; });
    })
    .then(function(savedCourse) {
      return chapters.reduce(function(chain, chapter) {
        return chain.then(function(c) {
          return createLessonFromChapter(c, chapter, user);
        });
      }, Promise.resolve(savedCourse));
    });
}

function createLessonFromChapter(course, chapter, user) {
  var lessonName = chapter.folderName.replace(/[-_]/g, ' ');
  var lesson = new Lesson({ name: lessonName });
  lesson.setOwner(user);

  return lesson.save()
    .then(function(savedLesson) {
      return chapter.materials.reduce(function(chain, mat) {
        return chain.then(function() {
          return createMaterialFromFile(savedLesson, mat, user);
        });
      }, Promise.resolve())
      .then(function() {
        course.lessons.push(savedLesson.id);
        return course.save();
      });
    });
}

function createMaterialFromFile(lesson, matFile, user) {
  var name = matFile.filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  var material = new Material({
    name    : name,
    content : matFile.content,
    type    : 'page',
    _owner  : user.id,
    unresolvedLegacyRefs : matFile.unresolvedLegacyRefs || []
  });
  material.setOwner(user);

  return material.save().then(function(savedMaterial) {
    lesson.materials.push(savedMaterial.id);
    return lesson.save();
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  importTrinkets : importTrinkets,
  importCourse   : importCourse
};
