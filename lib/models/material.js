var model    = require('./model'),
    mongoose = require('mongoose'),
    moment   = require('moment'),
    ObjectId = mongoose.SchemaTypes.ObjectId,
    ownable  = require('./plugins/ownable'),
    slug     = require('./plugins/slug'),
    schema   = {
      name:    { type: String, required: true },
      content: { type: String, set: pruneEmpty },
      isDraft: { type: Boolean },
      type:    { type: String, default: "page" }, // page, assignment
      trinket: {
        _id       : false,
        trinketId : { type: ObjectId, ref: 'Snippet' },
        name      : { type: String },
        shortCode : { type: String },
        lang      : { type: String },

        submissionsDue : {
          _id       : false,
          enabled   : { type: Boolean, default: false },
          dateValue : { type: Date }
        },

        submissionsCutoff : {
          _id       : false,
          enabled   : { type: Boolean, default: false },
          dateValue : { type: Date }
        },

        availableOn : {
          _id       : false,
          enabled   : { type: Boolean, default: false },
          dateValue : { type: Date }
        },

        hideAfter : {
          _id       : false,
          enabled   : { type: Boolean, default: false },
          dateValue : { type: Date }
        }
      },
      unresolvedLegacyRefs : [{ type: String }]
    };


function pruneEmpty(value) {
  if (value==null || value===''){
    return undefined;
  }
  return value;
}

function copy(user, parser, cb) {
  var that = this;
  var materialData = {
    name    : this.name,
    content : this.content,
    isDraft : this.isDraft,
    _owner  : user,
    type    : this.type,
    trinket : this.trinket
  };

  if (this.type === 'assignment') {
    Trinket.findById(this.trinket.trinketId)
      .then(function(trinket) {
        var trinketCopy = trinket.copy(user);
        return trinketCopy.save();
      })
      .then(function(trinketCopy) {
        materialData.trinket.trinketId = trinketCopy._id;
        materialData.trinket.name = trinketCopy.name;
        materialData.trinket.shortCode = trinketCopy.shortCode;
        materialData.trinket.lang = trinketCopy.lang;

        var material = new Material(materialData, that)

        material.save(function(err, doc) {
          cb(err, doc);
        });
      });
  }
  else {
    parser.parse(materialData.content, user)
      .then(function(parsedContent) {
        materialData.content = parsedContent;

        var material = new Material(materialData, that)

        material.save(function(err, doc) {
          cb(err, doc);
        });
      });
  }
}

function setDates(dates) {
  var self       = this
    , dateFields = ["submissionsDue", "submissionsCutoff", "availableOn", "hideAfter"];

  dateFields.forEach(function(dateField) {
    if (!self.trinket[dateField]) self.trinket[dateField] = {};
    self.trinket[dateField].enabled = dates[dateField + "Enabled"];
    if (self.trinket[dateField].enabled && dates[dateField]) {
      self.trinket[dateField].dateValue = dates[dateField];
    }
  });
}

function isVisible() {
  if (this.type === 'assignment') {
    if ( (this.trinket.availableOn.enabled && moment().isBefore(this.trinket.availableOn.dateValue))
    ||   (this.trinket.hideAfter.enabled   && moment().isAfter(this.trinket.hideAfter.dateValue)) ) {
      return false;
    }
  }

  return true;
}

var Material = model.create('Material', {
  schema:  schema,
  plugins: [
    ownable,
    [slug, { index: false }]
  ],
  objectMethods: {
    copy      : copy,
    setDates  : setDates,
    isVisible : isVisible
  },
  classMethods: {
    findByUnresolvedLegacyRefs: function(refs) {
      return this.model.find({ unresolvedLegacyRefs: { $in: refs } });
    }
  },
  publicSpec: {
      id               : true
    , name             : true
    , slug             : true
    , content          : true
    , isDraft          : true
    , type             : true
    , trinket          : true
    , lastUpdated      : true
  }
}).publicModel;

module.exports = Material;
