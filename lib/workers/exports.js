var exportsQueue = require('../util/queues').exports()
  , db           = require('../../config/db')
  , config       = require('../../config/app.config')
  , nunjucks     = require('nunjucks')
  , moment       = require('moment')
  , Q            = require('q')
  , fs           = require('fs')
  , path         = require('path')
  , url          = require('url')
  , crypto       = require('crypto')
  , archiver     = require('archiver')
  , aws          = require('../../config/aws')
  , mailer       = require('../util/mailer')
  , FileUtil     = require('../util/file')
  , Export       = require('../models/export')
  , User         = require('../models/user')
  , Trinket      = require('../models/trinket')
  , mongoose     = require('mongoose')
  , env;

var EXPORT_EXPIRY_DAYS = 3;

var langExtensions = {
  'python'     : '.py',
  'python3'    : '.py',
  'pygame'     : '.py',
  'html'       : '.html',
  'java'       : '.java',
  'R'          : '.R',
  'glowscript' : '.py',
  'blocks'     : '.xml',
  'console'    : '.py',
  'music'      : '.py',
  'skulpt'     : '.py'
};

// Download asset from S3
function downloadAsset(assetUrl) {
  var deferred = Q.defer();
  var parsed = url.parse(assetUrl);
  var filename = path.basename(parsed.pathname);

  var client = new aws.S3();
  client.getObject({
    Bucket: config.aws.buckets.userassets.name,
    Key: filename
  }, function(err, data) {
    if (err) return deferred.reject(err);
    deferred.resolve(data.Body);
  });

  return deferred.promise;
}

exportsQueue.on('error', function(err) {
  console.log('exports queue error:', err);
});

exportsQueue.on('failed', function(job, err) {
  console.log('exports failed job:', job.jobId, job.data);
  console.log('exports failed err:', err);

  if (job.data.exportId) {
    Export.findByIdAndUpdate(job.data.exportId, {
      status: 'failed',
      errorMessage: err.message || 'Unknown error'
    }, function() {});
  }
});

exportsQueue.on('completed', function(job, result) {
  job.remove();
});

exportsQueue.process(function(job) {
  var action = job.data.action;

  if (action === 'bulk-export') {
    return processBulkExport(job);
  }
  else {
    return Promise.reject(new Error('Unknown action: ' + action));
  }
});

function processBulkExport(job) {
  var exportId = job.data.exportId
    , userId   = job.data.userId
    , exportRecord
    , user
    , tempFile
    , s3Key
    , filename;

  // Generate unique filename
  var timestamp = Date.now();
  var hash = crypto.createHash('sha1')
    .update(userId + timestamp.toString())
    .digest('hex')
    .substring(0, 12);

  filename = 'trinket-export-' + hash + '.zip';
  tempFile = '/tmp/' + filename;
  s3Key = 'exports/' + userId + '/' + filename;

  if (!config.isTest) {
    env = nunjucks.configure(config.app.templates);
  }

  return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, { status: 'processing' })
    .then(function(record) {
      exportRecord = record;
      return Q.nsend(User.model || mongoose.model('User'), 'findById', userId);
    })
    .then(function(foundUser) {
      user = foundUser;
      if (!user) {
        throw new Error('User not found');
      }

      // Count total trinkets
      return Q.nsend(Trinket.model || mongoose.model('Snippet'), 'count', { _owner: userId });
    })
    .then(function(count) {
      // Update total count
      return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        'progress.total': count,
        trinketCount: count
      });
    })
    .then(function() {
      // Create the archive
      return createExportArchive(userId, exportId, tempFile);
    })
    .then(function(result) {
      // Upload to S3
      return uploadToS3(tempFile, s3Key, filename);
    })
    .then(function(downloadUrl) {
      var expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + EXPORT_EXPIRY_DAYS);

      // Get file size
      var stats = fs.statSync(tempFile);

      // Update export record with completion
      return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        status: 'completed',
        downloadUrl: downloadUrl,
        s3Key: s3Key,
        expiresAt: expiresAt,
        fileSize: stats.size
      }, { new: true });
    })
    .then(function(record) {
      exportRecord = record;
      // Send notification email
      return sendCompletionEmail(user, exportRecord);
    })
    .then(function() {
      // Cleanup temp file
      fs.unlink(tempFile, function() {});
      return Promise.resolve();
    })
    .fail(function(err) {
      // Cleanup on failure
      if (tempFile) {
        fs.unlink(tempFile, function() {});
      }

      return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        status: 'failed',
        errorMessage: err.message
      })
      .then(function() {
        if (user) {
          return sendFailureEmail(user, err.message);
        }
      })
      .then(function() {
        return Promise.reject(err);
      });
    });
}

function createExportArchive(userId, exportId, tempFile) {
  var deferred = Q.defer();
  var archive = archiver('zip', { zlib: { level: 6 } });
  var output = fs.createWriteStream(tempFile);
  var processed = 0;
  var failed = 0;
  var manifest = {
    exportedAt: new Date().toISOString(),
    trinkets: []
  };

  output.on('close', function() {
    deferred.resolve({ processed: processed, failed: failed });
  });

  output.on('error', function(err) {
    deferred.reject(err);
  });

  archive.on('error', function(err) {
    deferred.reject(err);
  });

  archive.pipe(output);

  // Use stream to iterate trinkets (older mongoose API)
  var TrinketModel = Trinket.model || mongoose.model('Snippet');
  var stream = TrinketModel.find({ _owner: userId })
    .select('shortCode name description lang code assets settings created lastUpdated folder')
    .stream();

  var trinketPromises = [];

  stream.on('data', function(trinket) {
    stream.pause();

    var trinketPromise = addTrinketToArchive(archive, trinket)
      .then(function(trinketInfo) {
        processed++;
        manifest.trinkets.push(trinketInfo);

        // Update progress every 10 trinkets
        if (processed % 10 === 0) {
          return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
            'progress.processed': processed,
            'progress.failed': failed
          });
        }
      })
      .fail(function(err) {
        failed++;
        console.log('Failed to add trinket:', trinket.shortCode, err.message);
      })
      .finally(function() {
        stream.resume();
      });

    trinketPromises.push(trinketPromise);
  });

  stream.on('end', function() {
    Q.all(trinketPromises)
      .then(function() {
        // Add manifest
        manifest.totalTrinkets = processed;
        manifest.failedTrinkets = failed;
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

        // Final progress update
        return Q.nsend(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
          'progress.processed': processed,
          'progress.failed': failed
        });
      })
      .then(function() {
        archive.finalize();
      })
      .fail(function(err) {
        deferred.reject(err);
      });
  });

  stream.on('error', function(err) {
    deferred.reject(err);
  });

  return deferred.promise;
}

function addTrinketToArchive(archive, trinket) {
  var deferred = Q.defer();
  var folderName = sanitizeFolderName(trinket.name || trinket.shortCode);
  var basePath = (trinket.lang || 'other') + '/' + folderName + '_' + trinket.shortCode + '/';

  // Add metadata file
  var metadata = {
    shortCode: trinket.shortCode,
    name: trinket.name,
    description: trinket.description,
    lang: trinket.lang,
    created: trinket.created,
    lastUpdated: trinket.lastUpdated,
    settings: trinket.settings,
    url: config.url + '/' + trinket.lang + '/' + trinket.shortCode
  };

  // Record the trinket's folder membership (a trinket belongs to at most one
  // folder) so importers can reconstruct it. Rides on each trinket's metadata.
  if (trinket.folder && trinket.folder.name) {
    metadata.folder = { name: trinket.folder.name, slug: trinket.folder.folderSlug };
  }

  archive.append(JSON.stringify(metadata, null, 2), { name: basePath + 'metadata.json' });

  // Add instructions (stored in description) as a readable markdown file
  if (trinket.description && trinket.description.length) {
    archive.append(trinket.description, { name: basePath + 'instructions.md' });
  }

  // Parse and add code files
  var codeFiles = parseCodeFiles(trinket);
  codeFiles.forEach(function(file) {
    archive.append(file.content || '', { name: basePath + file.name });
  });

  // Download and add assets
  var assetPromises = [];
  if (trinket.assets && trinket.assets.length) {
    trinket.assets.forEach(function(asset) {
      if (!asset.url) return;

      var assetFile = path.basename(url.parse(asset.url).pathname);

      var assetPromise = downloadAsset(asset.url)
        .then(function(buffer) {
          archive.append(buffer, { name: basePath + 'assets/' + (asset.name || assetFile) });
        })
        .fail(function(err) {
          // Log but don't fail entire trinket for one missing asset
          console.log('Asset download failed:', asset.name, err.message);
        });

      assetPromises.push(assetPromise);
    });
  }

  Q.allSettled(assetPromises)
    .then(function() {
      deferred.resolve({
        shortCode: trinket.shortCode,
        name: trinket.name,
        lang: trinket.lang
      });
    })
    .fail(function(err) {
      deferred.reject(err);
    });

  return deferred.promise;
}

function parseCodeFiles(trinket) {
  var code;
  try {
    code = JSON.parse(trinket.code);
    if (!Array.isArray(code)) {
      throw new Error('Not an array');
    }
  } catch(e) {
    // Single file trinket
    var extension = langExtensions[trinket.lang] || '.txt';
    var mainName = /blocks/.test(trinket.lang) ? 'main.xml' : 'main' + extension;

    code = [{
      name: mainName,
      content: trinket.code
    }];
  }
  return code;
}

function sanitizeFolderName(name) {
  return (name || 'untitled')
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50);
}

function uploadToS3(localPath, s3Key, filename) {
  var deferred = Q.defer();
  var client = new aws.S3();
  var readStream = fs.createReadStream(localPath);

  client.putObject({
    Bucket: config.aws.buckets.exports.name,
    Key: s3Key,
    Body: readStream,
    ContentType: 'application/zip',
    ContentDisposition: 'attachment; filename="' + filename + '"'
  }, function(err, data) {
    if (err) {
      return deferred.reject(err);
    }

    // Return the S3 key - we'll generate presigned URLs on download
    deferred.resolve(config.aws.buckets.exports.host + '/' + s3Key);
  });

  return deferred.promise;
}

function sendCompletionEmail(user, exportRecord) {
  var subject = 'Your Trinket Export is Ready';

  var templateData = {
    username: user.name || user.username,
    trinketCount: exportRecord.progress ? exportRecord.progress.processed : exportRecord.trinketCount,
    fileSize: formatFileSize(exportRecord.fileSize),
    expiresAt: moment(exportRecord.expiresAt).format('MMM D, YYYY'),
    downloadUrl: config.url + '/api/exports/' + exportRecord._id + '/download'
  };

  var html = nunjucks.render('emails/export-ready', templateData);

  return mailer.send(user.email, subject, { html: html, type: 'export-ready' });
}

function sendFailureEmail(user, errorMessage) {
  var subject = 'Your Trinket Export Failed';

  var templateData = {
    username: user.name || user.username,
    errorMessage: errorMessage || 'An unexpected error occurred'
  };

  var html = nunjucks.render('emails/export-failed', templateData);

  return mailer.send(user.email, subject, { html: html, type: 'export-failed' });
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
