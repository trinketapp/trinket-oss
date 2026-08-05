var should   = require('chai').should(),
    mongoose = require('mongoose'),
    db       = require('../../helpers/db'),
    User     = require('../../../lib/models/user'),
    Export   = require('../../../lib/models/export');

describe('Export model scope fields', function() {
  before(function(done) { db.ensureConnection(done); });

  it('defaults type to "trinkets" and accepts submission scope', function(done) {
    var owner = new User({
      fullname: 'Export Owner',
      username: 'exportowner',
      email: 'exportowner@example.com',
      password: 'password'
    });

    owner.save(function(err) {
      if (err) return done(err);

      new Export({ _owner: owner.id }).save(function(err, legacy) {
        if (err) return done(err);
        legacy.type.should.eql('trinkets');

        var cid = new mongoose.Types.ObjectId().toString();
        var mid = new mongoose.Types.ObjectId().toString();

        new Export({
          _owner: legacy._owner, type: 'assignment-submissions', courseId: cid, materialId: mid
        }).save(function(err, scoped) {
          if (err) return done(err);
          scoped.type.should.eql('assignment-submissions');
          scoped.courseId.toString().should.eql(cid);
          scoped.materialId.toString().should.eql(mid);
          done();
        });
      });
    });
  });
});
