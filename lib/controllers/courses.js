var _           = require('underscore'),
    parseUrl    = require('url').parse,
    diff        = require('diff'),
    Hapi        = require('@hapi/hapi'),
    util        = require('util'),
    fs          = require('fs'),
    mkdirp      = require('mkdirp'),
    rimraf      = require('rimraf'),
    zip         = require('adm-zip'),
    config      = require('config'),
    StringUtils = require('../util/stringUtils'),
    nunjucks    = require('../util/nunjucks'),
    parser      = require('../shared/trinket-markdown.js')({}),
    errors      = require('@hapi/boom'),
    ObjectUtils = require('../util/objectUtils'),
    File        = require('../models/file'),
    FileUtil    = require('../util/file'),
    Trinket     = require('../models/trinket');

// Matches /api/files/{id}/{filename} in markdown image/src references.
// Group 1 = full path, group 2 = MongoDB id, group 3 = filename.
var ASSET_ID_RE = /(?:\]\(|src=['"]?)(\/api\/files\/([^\/\s)"'>]+)\/([^\s)"'>]+))/g;

// Matches trinket embed iframes from any server (trinket.io or local).
// Group 1 = lang, group 2 = shortCode.
var EMBED_SC_RE = /<iframe[^>]+src=['"][^'"]*\/embed\/(\w+)\/([a-f0-9]{8,12})/gi;

function pad2(n) { return n < 10 ? '0' + n : String(n); }

module.exports = {
  creationForm : function(request, reply) {
    request.success();
  },

  create : async function(request, reply) {
    try {
      var response = await request.server.inject({
        url     : '/api/courses',
        method  : 'post',
        headers : {
          'content-type' : 'application/json',
          'accept'       : 'application/json'
        },
        payload : request.payload,
        auth    : {
          strategy    : 'session',
          credentials : request.auth.credentials
        }
      });

      if (response.result) {
        if (response.result.course) {
          request.success({
            course : response.result.course
          });
        }
        else if (response.result.err) {
          request.fail({
              err     : response.result.err
            , message : response.result.message
          });
        }
      }
    } catch (err) {
      request.fail({ err: err, message: err.message });
    }
  },

  getCourses : function(request, reply) {
    var roles;

    return request.user.getCourses()
      .then(function(courses) {
        return request.success({ data : courses });
      });
  },

  featuredCourses : function(request, reply) {
    return Course.findFeaturedForUser(request.user)
      .then(function(courses) {
        courses = _.map(courses, function(course) {
          page        = course.page;
          course      = ObjectUtils.serialize(course);
          course.page = page || "";

          return course;
        });
        return request.success({ data : courses });
      })
      .catch(function(error) {
        return request.success({ data : [] });
      });
  },

  copy : function(request, reply) {
    request.pre.course.copy(request.user, function(err, course) {
      var urlTemplate = (config.app.usersubdomains)
        ? '//{user}.{domain}/{course}'
        : '//{domain}/u/{user}/classes/{course}';

      var url = StringUtils.interpolate(urlTemplate, {
        user:   request.user.username,
        domain: config.app.url.hostname,
        course: course.slug
      });

      return request.user.grant("course-owner", "course", { id : course.id })
        .then(function() {
          request.success({ classPageUrl : url });
        });
    });
  },

  coursePage : function(request, reply) {
    var courseId = request.pre.course.id
      , isOwner  = request.user && request.user.hasRole('course-owner', 'course', { id : courseId })
      , canEdit  = request.user && request.user.hasPermission('manage-course-content', 'course', { id : courseId })
      , isAssoc  = request.user && request.user.hasRole('course-associate', 'course', { id : courseId })
      , urlTemplate, url, event;

    if (!(canEdit || isAssoc)) {
      urlTemplate = (config.app.usersubdomains)
        ? '//{user}.{domain}/{course}'
        : '//{domain}/u/{user}/classes/{course}';

      url = config.app.url.protocol + ':' + StringUtils.interpolate(urlTemplate, {
        user   : request.params.userSlug,
        domain : config.app.url.hostname,
        course : request.params.courseSlug
      });

      return reply().redirect(url);
    }

    request.success({
      courseId   : courseId,
      courseSlug : request.params.courseSlug,
      userSlug   : request.params.userSlug,
      canEdit    : canEdit,
      isAssoc    : isAssoc
    });

  },

  download : function(request, reply) {
    var owner  = request.pre.user
      , course = request.pre.course;

    if (request.user.hasRole("course-owner", "course", { id : course.id })
    ||  course.globalSettings.courseType === "public"
    ||  course.globalSettings.courseType === "open"
    ||  request.user.hasPermission("create-private-course")
    ||  request.user.hasPermission("make-course-copy", "course", { id : course.id })) {

      var format    = request.query.format;

      var mkdirpify = util.promisify(mkdirp);
      var writeFile = util.promisify(fs.writeFile);

      var ownerDir  = '/tmp/' + owner.username;
      var courseDir = ownerDir + '/' + course.slug;

      var fullCourse = {
        name        : course.name,
        description : course.description,
        lessons     : []
      };

      var mkLessonDirs = function() {
        return Promise.all(course.lessons.map(function(lesson, lessonIndex) {
          return Lesson.findById(lesson)
            .then(function(lesson) {
              var lessonDir = courseDir + '/' + pad2(lessonIndex) + '-' + lesson.slug;
              // Use a plain object so materials array won't cast values back to ObjectId
              fullCourse.lessons[ lessonIndex ] = {
                name      : lesson.name,
                slug      : lesson.slug,
                isDraft   : lesson.isDraft,
                materials : new Array(lesson.materials.length)
              };
              return mkdirpify(lessonDir)
                .then(function() {
                  return lesson.materials.map(function(material, materialIndex) {
                    return {
                      writeTo       : lessonDir,
                      material      : material,
                      lessonIndex   : lessonIndex,
                      materialIndex : materialIndex
                    };
                  });
                });
            });
        }));
      }

      var getMaterialContent = function(materialInfo) {
        var flatList = _.flatten(materialInfo);
        return Promise.all(flatList.map(function(info) {
          return Material.findById(info.material)
            .then(function(material) {
              var content = !material ? '' : material.content;

              fullCourse.lessons[ info.lessonIndex ].materials[ info.materialIndex ] = material;

              if (!material) { return null; }

              return {
                writeTo       : info.writeTo + '/' + pad2(info.materialIndex) + '-' + material.slug + '.' + format,
                content       : content,
                lessonIndex   : info.lessonIndex,
                materialIndex : info.materialIndex
              }
            });
        }));
      }

      var parseMaterialContent = function(contentInfo) {
        var context;

        return Promise.all(contentInfo.map(function(info) {
          // nunjucks parse of format is html
          if (format === "html") {
            var currentMaterialIndex
              , slides = [];

            fullCourse.lessons.map(function(lesson, lessonIndex) {
              lesson.materials.map(function(material, materialIndex) {
                slides.push( pad2(lessonIndex) + '-' + lesson.slug + '/' + pad2(materialIndex) + '-' + material.slug );
                if (lessonIndex === info.lessonIndex && materialIndex === info.materialIndex) {
                  currentMaterialIndex = slides.length - 1;
                }
              });
            });

            context = {
              pageContent   : parser(info.content),
              course        : fullCourse,
              owner         : owner,
              config        : config,
              lessonIndex   : info.lessonIndex,
              materialIndex : info.materialIndex,
              progress      : ( currentMaterialIndex + 1 ) / slides.length,
              prevPageHref  : currentMaterialIndex ? slides[ currentMaterialIndex - 1 ] : undefined,
              nextPageHref  : currentMaterialIndex + 1 <= slides.length ? slides[ currentMaterialIndex + 1 ] : undefined
            };

            return nunjucks.render('courses/download/view.html', context)
              .then(function(content) {
                return {
                  writeTo : info.writeTo,
                  content : content
                };
              });
          }
          else {
            return Promise.resolve({
              writeTo : info.writeTo,
              content : info.content
            });
          }
        }));
      }

      var writeMaterialFiles = function(files) {
        var writes = files.map(function(file) {
          return writeFile(file.writeTo, file.content);
        });

        var courseSettings = course.globalSettings || {};
        var manifest = {
          name           : fullCourse.name,
          description    : fullCourse.description,
          globalSettings : {
            courseType     : courseSettings.courseType,
            contentDefault : courseSettings.contentDefault,
            copyable       : courseSettings.copyable
          },
          lessons     : fullCourse.lessons.map(function(lesson, lessonIndex) {
            return {
              name      : lesson.name,
              slug      : lesson.slug,
              isDraft   : lesson.isDraft || false,
              materials : (lesson.materials || []).map(function(material) {
                var entry = { name: material.name, slug: material.slug, type: material.type || 'page', isDraft: material.isDraft || false };
                if (material.type === 'assignment' && material.trinket) {
                  entry.trinket = {
                    shortCode         : material.trinket.shortCode,
                    name              : material.trinket.name,
                    lang              : material.trinket.lang,
                    submissionsDue    : material.trinket.submissionsDue,
                    submissionsCutoff : material.trinket.submissionsCutoff,
                    availableOn       : material.trinket.availableOn,
                    hideAfter         : material.trinket.hideAfter
                  };
                }
                return entry;
              })
            };
          })
        };
        writes.push(writeFile(courseDir + '/course.json', JSON.stringify(manifest, null, 2)));

        return Promise.all(writes).then(function() { return files; });
      }

      // Downloads each /api/files/{id}/{filename} asset from S3 and writes it
      // into assets/{id}/{filename} inside the course temp dir so adm-zip picks
      // it up.  Best-effort: a missing or un-downloadable asset logs a warning
      // and is skipped rather than aborting the whole export.
      var embedAssets = function(files) {
        if (!config.features || !config.features.assets) return Promise.resolve(files);

        var assetMap = {};
        (files || []).filter(Boolean).forEach(function(file) {
          var re = new RegExp(ASSET_ID_RE.source, 'g');
          var match;
          while ((match = re.exec(file.content || '')) !== null) {
            if (!assetMap[match[2]]) assetMap[match[2]] = match[3];
          }
        });

        var ids = Object.keys(assetMap);
        if (!ids.length) return Promise.resolve(files);

        var assetsDir = courseDir + '/assets';
        return mkdirpify(assetsDir).then(function() {
          return Promise.all(ids.map(function(id) {
            var filename = assetMap[id];
            return File.findById(id)
              .then(function(fileRecord) {
                if (!fileRecord) {
                  console.warn('course export: no File record for id', id);
                  return;
                }
                // url = container.host + '/' + s3Key  →  s3Key is the last segment
                var s3Key = fileRecord.url.split('/').pop();
                return FileUtil.downloadMaterialFileAsBuffer(s3Key)
                  .then(function(buffer) {
                    var assetDir = assetsDir + '/' + id;
                    return mkdirpify(assetDir).then(function() {
                      return writeFile(assetDir + '/' + filename, buffer);
                    });
                  });
              })
              .catch(function(err) {
                console.warn('course export: could not embed asset', filename, err.message);
              });
          }));
        }).then(function() { return files; });
      }

      // Finds all trinket embed shortCodes in material content (from any server),
      // looks up the Trinket records, and writes them in the standard import
      // format under trinkets/{lang}/{name}_{shortCode}/ so the course zip is
      // self-contained.  Trinkets not found in the DB are skipped with a warning.
      var embedTrinkets = function(files) {
        var shortCodeMap = {};
        (files || []).filter(Boolean).forEach(function(file) {
          var re = new RegExp(EMBED_SC_RE.source, 'gi');
          var match;
          while ((match = re.exec(file.content || '')) !== null) {
            if (!shortCodeMap[match[2]]) shortCodeMap[match[2]] = match[1];
          }
        });

        // Also bundle assignment trinkets — they aren't embedded in content
        // but are linked via material.trinket metadata in course.json
        fullCourse.lessons.forEach(function(lesson) {
          (lesson.materials || []).forEach(function(material) {
            if (material && material.type === 'assignment' &&
                material.trinket && material.trinket.shortCode &&
                !shortCodeMap[material.trinket.shortCode]) {
              shortCodeMap[material.trinket.shortCode] = material.trinket.lang;
            }
          });
        });

        var shortCodes = Object.keys(shortCodeMap);
        if (!shortCodes.length) return Promise.resolve();

        var trinketDir = courseDir + '/trinkets';
        return mkdirpify(trinketDir).then(function() {
          return Trinket.findByShortCodes(shortCodes).exec().then(function(trinkets) {
            var manifestEntries = [];

            return Promise.all(trinkets.map(function(trinket) {
              var safeName   = (trinket.name || 'trinket').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
              var folderPath = trinketDir + '/' + trinket.lang + '/' + safeName + '_' + trinket.shortCode;

              manifestEntries.push({ shortCode: trinket.shortCode, lang: trinket.lang });

              return mkdirpify(folderPath).then(function() {
                var meta = JSON.stringify({ name: trinket.name, description: trinket.description, lang: trinket.lang, settings: trinket.settings }, null, 2);

                var codeFiles;
                try {
                  codeFiles = JSON.parse(trinket.code);
                  if (!Array.isArray(codeFiles)) throw new Error();
                } catch(e) {
                  var mainName = /blocks/.test(trinket.lang) ? 'main.xml' : 'main.txt';
                  codeFiles = [{ name: mainName, content: trinket.code || '' }];
                }

                var writes = [writeFile(folderPath + '/metadata.json', meta)];
                if (trinket.description && trinket.description.length) {
                  writes.push(writeFile(folderPath + '/instructions.md', trinket.description));
                }
                codeFiles.forEach(function(cf) {
                  writes.push(writeFile(folderPath + '/' + cf.name, cf.content || ''));
                });
                return Promise.all(writes);
              }).catch(function(err) {
                console.warn('course export: could not embed trinket', trinket.shortCode, err.message);
              });
            })).then(function() {
              return writeFile(trinketDir + '/manifest.json',
                JSON.stringify({ trinkets: manifestEntries }, null, 2));
            });
          });
        });
      }

      var zipCourse = function() {
        return Promise.resolve().then(function() {
          var zipFile = courseDir + '.zip';
          var courseZip = new zip();
          courseZip.addLocalFolder(courseDir);
          courseZip.writeZip(zipFile);
          return zipFile;
        });
      }

      var returnZip = function(zipFile) {
        fs.stat(zipFile, function(err, stats) {
          var stream = fs.createReadStream(zipFile);
          rimraf(ownerDir, function() {
            return reply(stream)
              .type('application/zip')
              .bytes(stats.size)
              .header('Content-Disposition', 'attachment; filename=' + course.slug + '.zip');
          });
        });
      }

      return mkdirpify(courseDir)
        .then(mkLessonDirs)
        .then(getMaterialContent)
        .then(parseMaterialContent)
        .then(writeMaterialFiles)
        .then(embedAssets)
        .then(embedTrinkets)
        .then(zipCourse)
        .then(returnZip)
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  }
};
