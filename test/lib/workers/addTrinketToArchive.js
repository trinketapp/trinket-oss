var should = require('chai').should();

// lib/workers/exports.js pulls in config/app.config -> routes -> hapi at
// require time (via the exports queue processor registration). Requiring it
// lazily inside before() — rather than at module top — matters because mocha
// loads every test/**/*.js file (this one included) as a spec file in
// alphabetical order; if a file that pulls in mongoose-schema-extend (e.g.
// test/helpers/db.js) has already loaded by the time this file is collected,
// requiring lib/workers/exports.js at module top would hit the
// mongoose-schema-extend / @hapi/shot version-skew crash documented in
// PORT-REPORT.md. Requiring inside before() defers it to run time, by which
// point the suite's own dependency chain has already settled.
var addTrinketToArchive;

describe('addTrinketToArchive basePath', function() {
  before(function() {
    addTrinketToArchive = require('../../../lib/workers/exports').addTrinketToArchive;
  });

  function fakeArchive() {
    var names = [];
    return {
      names: names,
      append: function(content, opts) { names.push(opts.name); }
    };
  }

  var trinket = { shortCode: 'abc123', name: 'My Sim', lang: 'python3', code: 'print(1)', assets: [], settings: {} };

  it('uses default <lang>/<name>_<shortCode>/ when no options', function(done) {
    var a = fakeArchive();
    addTrinketToArchive(a, trinket).then(function() {
      a.names.some(function(n) { return n.indexOf('python3/My_Sim_abc123/') === 0; }).should.eql(true);
      done();
    }).catch(done);
  });

  it('honors options.basePath', function(done) {
    var a = fakeArchive();
    addTrinketToArchive(a, trinket, { basePath: 'assignment-1/jane/' }).then(function() {
      a.names.every(function(n) { return n.indexOf('assignment-1/jane/') === 0; }).should.eql(true);
      a.names.should.include('assignment-1/jane/metadata.json');
      done();
    }).catch(done);
  });
});
