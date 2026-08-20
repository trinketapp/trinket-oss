var should   = require('chai').should(),
    readZip  = require('../../helpers/readZip'),
    fs       = require('fs'),
    os       = require('os'),
    path     = require('path'),
    db       = require('../../helpers/db'),
    User     = require('../../../lib/models/user'),
    Trinket  = require('../../../lib/models/trinket'),
    Material = require('../../../lib/models/material'),
    Lesson   = require('../../../lib/models/lesson'),
    Course   = require('../../../lib/models/course'),
    Export   = require('../../../lib/models/export');

// See test/lib/workers/addTrinketToArchive.js for why this is required
// lazily inside before() rather than at module top.
var createSubmissionsArchive, sanitizeFolderName;

describe('createSubmissionsArchive', function() {
  before(function() {
    var exportsWorker = require('../../../lib/workers/exports');
    createSubmissionsArchive = exportsWorker.createSubmissionsArchive;
    sanitizeFolderName       = exportsWorker.sanitizeFolderName;

    // app.js normally assigns these as globals ("global for backwards
    // compatibility") after booting the full hapi server; several model
    // methods reach for the bare global rather than requiring the model
    // themselves (e.g. lib/models/plugins/roles.js's course.addUser uses
    // global User). Assign them directly here so this test can exercise
    // real DB/model behavior without booting the whole app (same pattern
    // test/lib/models/trinket.js uses for global.Interaction).
    global.User     = User;
    global.Course   = Course;
    global.Lesson   = Lesson;
    global.Material = Material;
    global.Trinket  = Trinket;
  });

  before(function(done) { db.ensureConnection(done); });

  var owner, student1, student2, course, material, tempFile;

  // Full-DB reset before every test (not just once per file): each test
  // recreates the same fixture usernames/emails (profowner, janestudent,
  // bobstudent), which would collide on mongoose's unique index the second
  // time through without this.
  beforeEach(function(done) { db.reset(done); });

  beforeEach(function(done) {
    owner = new User({ fullname: 'Prof Owner', username: 'profowner', email: 'profowner@example.com', password: 'password' });

    owner.save(function(err) {
      if (err) return done(err);

      student1 = new User({ fullname: 'Jane Student', username: 'janestudent', email: 'jane@example.com', password: 'password' });
      student1.save(function(err) {
        if (err) return done(err);

        student2 = new User({ fullname: 'Bob Student', username: 'bobstudent', email: 'bob@example.com', password: 'password' });
        student2.save(function(err) {
          if (err) return done(err);

          var promptTrinket = new Trinket({
            name: 'Assignment Prompt', lang: 'python3', code: 'print("prompt")',
            _owner: owner, _creator: owner
          });

          promptTrinket.save(function(err) {
            if (err) return done(err);

            material = new Material({
              name: 'HW1', type: 'assignment', _owner: owner,
              trinket: {
                trinketId: promptTrinket.id,
                name: promptTrinket.name,
                shortCode: promptTrinket.shortCode,
                lang: promptTrinket.lang
              }
            });

            material.save(function(err) {
              if (err) return done(err);

              var lesson = new Lesson({ name: 'Lesson 1', _owner: owner, materials: [material.id] });
              lesson.save(function(err) {
                if (err) return done(err);

                course = new Course({ name: 'Physics 101', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
                course.save(function(err) {
                  if (err) return done(err);

                  course.addUser(owner, ['course-owner'])
                    .then(function() { return course.addUser(student1, ['course-student']); })
                    .then(function() { return course.addUser(student2, ['course-student']); })
                    .then(function() {
                      var sub1 = new Trinket({
                        name: 'Jane Submission', lang: 'python3', code: 'print("jane")',
                        _owner: student1, _creator: student1,
                        courseId: course.id, materialId: material.id,
                        submissionState: 'submitted', submittedOn: new Date(),
                        comments: [{ commentType: 'feedback', commentText: 'nice', commented: new Date(), displayName: 'Prof Owner' }]
                      });
                      return sub1.save();
                    })
                    .then(function() {
                      var sub2 = new Trinket({
                        name: 'Bob Submission', lang: 'python3', code: 'print("bob")',
                        _owner: student2, _creator: student2,
                        courseId: course.id, materialId: material.id,
                        submissionState: 'submitted', submittedOn: new Date()
                      });
                      return sub2.save();
                    })
                    .then(function() {
                      tempFile = path.join(os.tmpdir(), 'test-submissions-archive-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.zip');
                      done();
                    })
                    .catch(done);
                });
              });
            });
          });
        });
      });
    });
  });

  afterEach(function() {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('builds a by-assignment/student archive with manifest, prompt, code, feedback, and metadata', function(done) {
    new Export({ type: 'course-submissions', courseId: course.id, _owner: owner }).save(function(err, exportRecord) {
      if (err) return done(err);

      createSubmissionsArchive(exportRecord, tempFile).then(function(result) {
        result.processed.should.eql(2);
        result.failed.should.eql(0);
        result.assignmentCount.should.eql(1);

        var names = readZip.listEntries(tempFile);

        names.should.include('manifest.json');
        names.some(function(n) { return n.indexOf('HW1/_assignment/') === 0; }).should.eql(true);
        names.should.include('HW1/janestudent/main.py');
        names.should.include('HW1/janestudent/feedback.md');
        names.should.include('HW1/janestudent/submission.json');
        names.should.include('HW1/bobstudent/main.py');
        names.should.include('HW1/bobstudent/feedback.md');
        names.should.include('HW1/bobstudent/submission.json');

        var janeFeedback = readZip.readAsText(tempFile, 'HW1/janestudent/feedback.md');
        janeFeedback.should.include('nice');

        var bobFeedback = readZip.readAsText(tempFile, 'HW1/bobstudent/feedback.md');
        bobFeedback.should.match(/No feedback/i);

        var janeMeta = JSON.parse(readZip.readAsText(tempFile, 'HW1/janestudent/submission.json'));
        janeMeta.state.should.eql('submitted');
        janeMeta.hasFeedback.should.eql(true);
        janeMeta.should.not.have.property('score');

        var manifest = JSON.parse(readZip.readAsText(tempFile, 'manifest.json'));
        manifest.scope.should.eql('course-submissions');
        manifest.course.name.should.eql('Physics 101');
        manifest.assignments.should.have.length(1);
        manifest.assignments[0].slug.should.eql('HW1');
        manifest.assignments[0].submissionCount.should.eql(2);
        manifest.assignments[0].students.map(function(s) { return s.slug; }).sort().should.eql(['bobstudent', 'janestudent']);

        done();
      }).catch(done);
    });
  });

  it('restricts to a single assignment for assignment-submissions scope', function(done) {
    new Export({
      type: 'assignment-submissions', courseId: course.id, materialId: material.id, _owner: owner
    }).save(function(err, exportRecord) {
      if (err) return done(err);

      createSubmissionsArchive(exportRecord, tempFile).then(function(result) {
        result.assignmentCount.should.eql(1);

        var names = readZip.listEntries(tempFile);
        names.every(function(n) { return n === 'manifest.json' || n.indexOf('HW1/') === 0; }).should.eql(true);

        done();
      }).catch(done);
    });
  });

  it('records an empty assignment with submissionCount 0 and skips a missing prompt trinket', function(done) {
    var TrinketModel = Trinket.model;

    TrinketModel.deleteMany({ materialId: material.id }).then(function() {
      material.trinket.trinketId = '507f191e810c19729de860ea';
      return material.save();
    }).then(function() {
      return new Export({ type: 'course-submissions', courseId: course.id, _owner: owner }).save();
    }).then(function(exportRecord) {
      return createSubmissionsArchive(exportRecord, tempFile);
    }).then(function(result) {
      result.processed.should.eql(0);
      result.assignmentCount.should.eql(1);

      var names = readZip.listEntries(tempFile);
      names.should.eql(['manifest.json']);

      var manifest = JSON.parse(readZip.readAsText(tempFile, 'manifest.json'));
      manifest.assignments[0].submissionCount.should.eql(0);
      manifest.assignments[0].students.should.eql([]);

      done();
    }).catch(done);
  });

  // Defense-in-depth: the student folder slug must go through
  // sanitizeFolderName like the assignment slug does, even though the
  // username source is normally trusted (unique, server-controlled), so a
  // stray path character (e.g. from a legacy/imported account) can never
  // produce a zip entry that escapes the assignment folder.
  it('sanitizes a student username containing an unsafe path character into a single folder segment', function(done) {
    student1.username = 'bad/name';

    student1.save().then(function() {
      var CourseModel = Course.model;
      return CourseModel.updateOne(
        { _id: course.id, users: { $elemMatch: { userId: student1.id } } },
        { $set: { 'users.$.username': 'bad/name' } }
      );
    }).then(function() {
      return new Export({ type: 'course-submissions', courseId: course.id, _owner: owner }).save();
    }).then(function(exportRecord) {
      return createSubmissionsArchive(exportRecord, tempFile);
    }).then(function(result) {
      result.processed.should.eql(2);

      var names = readZip.listEntries(tempFile);

      var sanitized = sanitizeFolderName('bad/name');
      sanitized.should.eql('badname');
      names.should.include('HW1/' + sanitized + '/main.py');
      names.some(function(n) { return n.indexOf('HW1/bad/') === 0; }).should.eql(false);

      names.should.include('HW1/bobstudent/main.py');

      done();
    }).catch(done);
  });
});
