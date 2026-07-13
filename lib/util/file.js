var PassThrough         = require('stream').PassThrough,
    crypto              = require('crypto'),
    config              = require('config'),
    aws                 = require('../../config/aws'),
    fs                  = require('fs');

function FileUtil() {
  var self = this;

  this._upload = function(stream, container, s3, fileinfo, cb) {
    var client = new aws.S3();
    client.putObject({
      Bucket      : container.name,
      Key         : fileinfo.name,
      Body        : stream,
      ContentType : fileinfo.contentType
    }, function(err, data) {
      cb(err, data);
    });
  }

  this._fileToContainer = function(upload, container, s3, cb) {
    var contentType = upload.headers['content-type'];

    var filename  = upload.filename;
    var extension = filename.lastIndexOf('.') > -1 ? filename.substring(filename.lastIndexOf('.') + 1, filename.length) : '';

    if (config.app.extensionWhitelist[extension]) {
      contentType = config.app.extensionWhitelist[extension];
    }

    self.hashcontents(upload.path, function(digest) {
      var fileinfo = {
        name        : digest,
        contentType : contentType
      };

      if (container.fileId) {
        fileinfo.name += '-' + container.fileId;
      }
      if (extension) {
        fileinfo.name += '.' + extension;
      }

      // have not been able to find a reliable way to reuse stream from above
      var uploadStream = fs.createReadStream(upload.path);

      self._upload(uploadStream, container, s3, fileinfo, function(err) {
        err && console.log(err);

        // remove temporary file
        fs.unlink(upload.path, function(err) {
          cb(err, {
            host : container.host,
            path : fileinfo.name,
            name : fileinfo.name,
            hash : digest,
            size : upload.bytes
          });
        });
      });
    });
  };

  // returns sha1 digest of files contents
  this.hashcontents = function(path, cb) {
    var stream = fs.createReadStream(path);
    var hash   = crypto.createHash('sha1');

    hash.setEncoding('hex');

    stream.on('end', function() {
      hash.end();
      cb(hash.read());
    });

    stream.pipe(hash);
  }

  this.downloadMaterialFile = function(remote) {
    var stream = new PassThrough;
    var client = new aws.S3();
    client.getObject({
      Bucket : config.aws.buckets.materials.name,
      Key    : remote
    }).createReadStream().pipe(stream);

    return stream;
  };

  this.downloadMaterialFileAsBuffer = function(remote) {
    var client = new aws.S3();
    return new Promise(function(resolve, reject) {
      client.getObject({ Bucket: config.aws.buckets.materials.name, Key: remote },
        function(err, data) { if (err) reject(err); else resolve(data.Body); });
    });
  };

  this.uploadMaterialFile = function(upload, cb) {
    var container = config.aws.buckets.materials;
    self._fileToContainer(upload, container, true, cb);
  };

  this.uploadUserAvatar = function(upload, cb) {
    if (!/^image\/(png|jpg|jpeg)$/.test(upload.headers['content-type'])) {
      return cb(new Error('unsupported image type, must be png or jpg'));
    }
    var container = config.aws.buckets.useravatars;
    self._fileToContainer(upload, container, true, cb);
  };

  // can be removed once uploadSnapshotFromBuffer has been tested in prod
  this.uploadSnapshot = function(file, cb) {
    // strange but seems necessary in certain situations...
    setTimeout(function() {
      fs.exists(file.path + file.name, function(snapshotExists) {
        if (snapshotExists) {
          var uploadStream = fs.createReadStream(file.path + file.name);
          var fileinfo = {
            name        : file.name,
            contentType : 'image/png'
          };
          self._upload(uploadStream, config.aws.buckets.snapshots, true, fileinfo, cb);
        }
        else {
          cb(new Error("Snapshot does not exists: " + file.path + file.name));
        }
      });
    }, 1000);
  }

  this.uploadSnapshotFromBuffer = function(filename, filedata, cb) {
    var fileinfo = {
      name: filename,
      contentType: 'image/png'
    };
    self._upload(filedata, config.aws.buckets.snapshots, true, fileinfo, cb);
  }

  this.removeFile = function(container, file, cb) {
    var client, filename;

    if (typeof(cb) !== 'function') {
      cb = function(err, result) {
        return result;
      }
    }

    client   = new aws.S3();
    filename = file.substring(file.lastIndexOf('/') + 1, file.length);
    client.deleteObject({
      Bucket : config.aws.buckets[container].name,
      Key    : filename
    }, cb);
  }

  this.uploadUserAsset = function(fileupload, user, replaceFile, cb) {
    var contentType = fileupload.headers['content-type'];
    var filename    = fileupload.filename;
    var extension   = filename.lastIndexOf('.') > -1 ? filename.substring(filename.lastIndexOf('.') + 1, filename.length) : '';

    if (typeof replaceFile === 'function') {
      cb = replaceFile;
      replaceFile = null;
    }

    self.hashcontents(fileupload.path, function(digest) {
      var container = config.aws.buckets.userassets
        , remoteName, file;

      if (replaceFile != null) {
        file = replaceFile;
      }
      else {
        file = new File();
      }

      file.name = filename;
      file.type = 'embed';
      file.mime = contentType;
      file.hash = digest;
      file.size = fileupload.bytes;

      file.setOwner(user);

      remoteName = digest + '-' + file.id + '.' + extension;
      file.url   = container.host + '/' + remoteName;

      file.save(function(err, file) {
        if (err) return cb(err);

        var uploadStream = fs.createReadStream(fileupload.path);
        var fileinfo = {
          name        : remoteName,
          contentType : contentType
        };
        self._upload(uploadStream, container, true, fileinfo, function(err, results) {
          cb(err, file);
        });
      });
    });
  }

  this.downloadUserAsset = function(remote) {
    var client = new aws.S3();

    return new Promise(function(resolve, reject) {
      client.getObject({
        Bucket : config.aws.buckets.userassets.name,
        Key    : remote
      }, function(err, data) {
        if (err) {
          return reject(err);
        }

        // Body is a Buffer that can be streamed
        return resolve(data.Body);
      });
    });
  };

  // TODO: implement as needed
  this.uploadOrgImage = function(stream, cb) {
    cb(null);
  };
}

module.exports = new FileUtil();
