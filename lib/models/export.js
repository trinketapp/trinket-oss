var mongoose = require('mongoose'),
    ObjectId = mongoose.SchemaTypes.ObjectId,
    model    = require('./model'),
    schema   = {
      _owner        : { type: ObjectId, ref: 'User', required: true, index: true },
      type          : { type: String, enum: ['trinkets', 'course-submissions', 'assignment-submissions'], default: 'trinkets' },
      courseId      : { type: ObjectId, ref: 'Course', index: true },
      materialId    : { type: ObjectId, ref: 'Material', index: true },
      status        : { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
      progress      : {
        total       : { type: Number, default: 0 },
        processed   : { type: Number, default: 0 },
        failed      : { type: Number, default: 0 }
      },
      downloadUrl   : { type: String },
      s3Key         : { type: String },
      expiresAt     : { type: Date, index: true },
      fileSize      : { type: Number },
      trinketCount  : { type: Number },
      errorMessage  : { type: String }
    };

function findByOwner(user) {
  var query = { _owner: user.id };
  // Use lean() to return plain JS objects instead of mongoose documents
  // This avoids circular reference issues with the serialize function
  return this.model.find(query).lean().exec();
}

function findPendingOrProcessing(ownerId) {
  return this.model.findOne({
    _owner: ownerId,
    status: { $in: ['pending', 'processing'] }
  }).exec();
}

function findRecentCompleted(ownerId, hoursAgo) {
  var cutoff = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  return this.model.findOne({
    _owner: ownerId,
    status: 'completed',
    created: { $gte: cutoff }
  }).exec();
}

var Export = model.create('Export', {
    schema : schema
  , classMethods : {
      findByOwner            : findByOwner,
      findPendingOrProcessing: findPendingOrProcessing,
      findRecentCompleted    : findRecentCompleted
    }
});

module.exports = Export.publicModel;
