var should   = require('chai').should(),
    flow     = require('../../helpers/flow'),
    defaults = require('../../helpers/defaults'),
    db       = require('../../helpers/db'),
    Export   = require('../../../lib/models/export'),
    User     = require('../../../lib/models/user');

describe('Course/Assignment student-work export endpoints', function() {
  before(function(done) { db.ensureConnection(done); });

  // Full-DB reset before every test: every scenario below recreates its own
  // 'user'/'admin' fixtures (flow.switchUser auto-signs-up on first use) and
  // a default-named course, which would collide with a prior test's leftover
  // "test course" for the same owner without this.
  beforeEach(function(done) { db.reset(done); });

  beforeEach(function() {
    flow.cookies = {};
  });

  describe('As the course owner (instructor)', function() {
    var courseId, materialId;

    beforeEach(function(done) {
      flow.switchUser('user', function(err) {
        if (err) return done(err);

        flow.createCourse(function(err) {
          if (err) return done(err);
          courseId = flow.lastResponse.body.course.id;

          flow.addNewLesson(courseId, function(err) {
            if (err) return done(err);
            var lessonId = flow.lastResponse.body.data.id;

            flow.addNewMaterial(courseId, lessonId, function(err) {
              if (err) return done(err);
              materialId = flow.lastResponse.body.data.id;
              done();
            });
          });
        });
      });
    });

    it('should enqueue a course-submissions export and return the exportId', function(done) {
      flow.post('/api/courses/' + courseId + '/exports/submissions')
        .send({})
        .end(flow.setLastResponse(function(err) {
          if (err) return done(err);

          flow.wasOk.should.eql(true);
          flow.lastResponse.statusCode.should.eql(200);
          flow.lastResponse.body.success.should.eql(true);
          flow.lastResponse.body.data.should.have.property('exportId');
          flow.lastResponse.body.data.status.should.eql('pending');

          Export.findById(flow.lastResponse.body.data.exportId, function(err, exportRecord) {
            if (err) return done(err);
            should.exist(exportRecord);
            exportRecord.type.should.eql('course-submissions');
            exportRecord.courseId.toString().should.eql(courseId);
            done();
          });
        }));
    });

    it('should enqueue an assignment-submissions export and return the exportId', function(done) {
      flow.post('/api/courses/' + courseId + '/materials/' + materialId + '/exports/submissions')
        .send({})
        .end(flow.setLastResponse(function(err) {
          if (err) return done(err);

          flow.wasOk.should.eql(true);
          flow.lastResponse.statusCode.should.eql(200);
          flow.lastResponse.body.success.should.eql(true);
          flow.lastResponse.body.data.should.have.property('exportId');
          flow.lastResponse.body.data.status.should.eql('pending');

          Export.findById(flow.lastResponse.body.data.exportId, function(err, exportRecord) {
            if (err) return done(err);
            should.exist(exportRecord);
            exportRecord.type.should.eql('assignment-submissions');
            exportRecord.courseId.toString().should.eql(courseId);
            exportRecord.materialId.toString().should.eql(materialId);
            done();
          });
        }));
    });
  });

  describe('As an instructor with an export already in flight', function() {
    // Use a distinct owner (admin) + course from the block above, so this
    // test isn't racing the queue's async processing of exports created by
    // earlier tests for the same user.
    var courseId, inFlight;

    beforeEach(function(done) {
      flow.switchUser('admin', function(err) {
        if (err) return done(err);

        flow.createCourse(function(err) {
          if (err) return done(err);
          courseId = flow.lastResponse.body.course.id;

          User.findByLogin(defaults.admin.email, function(err, owner) {
            if (err) return done(err);

            new Export({
              _owner: owner.id,
              type: 'course-submissions',
              courseId: courseId,
              status: 'processing'
            }).save(function(err, saved) {
              if (err) return done(err);
              inFlight = saved;
              done();
            });
          });
        });
      });
    });

    it('should reject a new export request with the in-flight exportId', function(done) {
      flow.post('/api/courses/' + courseId + '/exports/submissions')
        .send({})
        .end(flow.setLastResponse(function(err) {
          if (err) return done(err);

          // request.fail() replies 200 with an {error, ...} body (same
          // soft-failure convention as users.js#requestExport) rather than a
          // distinct HTTP error status.
          flow.lastResponse.statusCode.should.eql(200);
          flow.lastResponse.body.error.should.eql('Export already in progress');
          flow.lastResponse.body.exportId.should.eql(inFlight._id.toString());

          done();
        }));
    });
  });

  describe('As a logged-in user who is not a member of the course', function() {
    var courseId, materialId;

    beforeEach(function(done) {
      flow.switchUser('user', function(err) {
        if (err) return done(err);

        flow.createCourse(function(err) {
          if (err) return done(err);
          courseId = flow.lastResponse.body.course.id;

          flow.addNewLesson(courseId, function(err) {
            if (err) return done(err);
            var lessonId = flow.lastResponse.body.data.id;

            flow.addNewMaterial(courseId, lessonId, function(err) {
              if (err) return done(err);
              materialId = flow.lastResponse.body.data.id;

              // admin is a distinct, real account but has no role on this course
              flow.switchUser('admin', done);
            });
          });
        });
      });
    });

    it('should 403 on the course export endpoint', function(done) {
      flow.post('/api/courses/' + courseId + '/exports/submissions')
        .send({})
        .end(flow.setLastResponse(function(err) {
          if (err) return done(err);
          flow.lastResponse.statusCode.should.eql(403);
          done();
        }));
    });

    it('should 403 on the assignment export endpoint', function(done) {
      flow.post('/api/courses/' + courseId + '/materials/' + materialId + '/exports/submissions')
        .send({})
        .end(flow.setLastResponse(function(err) {
          if (err) return done(err);
          flow.lastResponse.statusCode.should.eql(403);
          done();
        }));
    });
  });
});
