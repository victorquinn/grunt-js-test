'use strict';

// Nodejs libs.
var fs = require('fs');
var path = require('path');

var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');

var app = express();

app.locals.pretty = true; // output pretty HTML
app.set('views', path.join(__dirname, '..', '..', 'views'));
app.set('view engine', 'jade');
app.use(bodyParser.text({ limit: '200mb' }));
// app.use(express.errorHandler());

// proxy static js-test-env javascript files
app.use('/js-test-env', express.static(path.join(__dirname, '..', '..', 'views', 'deps')));

module.exports = function (grunt, options) {
  var tests = require('./findTests')(grunt, options);
  var utils = require('./utils')(grunt, options);

  // set template data
  app.locals.tests = tests;
  app.locals.options = options;
  app.locals.utils = utils;
  app.use(function (req, res, next) {
    res.locals.coverage = typeof req.query.coverage !== 'undefined';
    res.locals.defaultBaseUri = '//' + req.hostname + ':' + options.port;
    res.locals.projectBaseUri = '//' + req.hostname + ':' + (res.locals.coverage ? options.coverageProxyPort : options.staticPort) + '/';
    next();
  });

  // create a static file server for project assets
  var statics = express();

  // ensure all responses are utf8 and are accessible cross-domain
  // this is needed so we can perform ajax requests to get the contents
  // of these static files from within the coverage report viewer
  statics.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With');
    next();
  });

  statics.use(options.baseUri, express.static(options.root));
  statics.listen(options.staticPort);

  // start coverage instrumentation proxy server
  var coverageTool, coverageReportDirectory, createdCoverageReportDirectory;
  if (options.coverage) {
    try {
      coverageReportDirectory = utils.coverageReportDirectory();
      coverageTool = require('./coverage-reporters/' + options.coverageTool)(grunt, options, coverageReportDirectory);
    } catch (ex) {
      options.coverageTool = null;
      options.coverage = false;
      grunt.log.error('Unsupported coverage reporter, disabling coverage.');
    } finally {
      coverageTool.start();
    }
  }

  // list of unit tests
  app.get('/', function (req, res) {
    res.render('index');
  });

  // store the jscover report to disk
  app.post('/jscoverage.json', function (req, res) {
    // we need data to write to the file
    if (!req.body) {
      grunt.log.error('No Coverage JSON data provided in POST, should never happen.');
      return res.status(500).send('No JSON data provided.');
    }

    if (!createdCoverageReportDirectory) {
      fs.mkdirSync(coverageReportDirectory);
      createdCoverageReportDirectory = true;
    }

    coverageTool.save(req.body, function (err) {
      if (err) {
        grunt.log.error('Failed to save coverage data.');
        res.status(500).send({ success: false });
      } else {
        grunt.verbose.writeln('Saved coverage data.');
        res.status(200).send({ success: true });
      }
    });
  });

  app.saveCoverageReport = function (cb) {
    coverageTool.aggregate(function (err) {
      cb(err);
    });
  };

  app.get('/save-coverage-data', function (req, res) {
    app.saveCoverageReport(function (err) {
      if (err) {
        grunt.log.error('Failed to create coverage report.');
        res.status(500).send({ success: false });
      } else {
        grunt.verbose.writeln('Saved coverage report.');
        res.status(200).send({ success: true });
      }
    });
  });

  // run all tests for a given project
  app.get('/all', function (req, res) {
    // we run each each test in isolation, which creates an iframe
    // to /test/:test for each test
    res.render('all', {
      coverage: typeof req.query.coverage !== 'undefined'
    });
  });

  // run a single test given the index number
  // TODO: change from index numbers to paths
  app.get('/test/:test', function (req, res) {
    var test = tests[req.params.test];

    // if we do not have this test, 404?
    if (!test) {
      return res.status(404).send('Test not found.');
    }

    var deps = options.referenceTags ? utils.getDependencies(test.abs) : [];
    var moduleName;

    // determine if we want to generate coverage reports
    var coverage = typeof req.query.coverage !== 'undefined';

    // attempt to find the module name for this file
    if (options.requirejs) {
      moduleName = path.relative(options.modulesRelativeTo || options.root, test.abs).replace(/\\/g, '/').replace(/\.js$/, '');
    }

    var render = function (injectHTML) {
      res.render('test', {
        modules: moduleName || '',
        injectHTML: injectHTML,
        test: test,
        deps: deps,
        coverage: coverage
      });
    };

    var injectHTML = options.injectHTML || '';

    // if test has an inject HTML file, inject it
    if (test.injectFiles && test.injectFiles.length > 0) {
      test.injectFiles.forEach(function (injectFile) {
        injectHTML += fs.readFileSync(injectFile);
      });
    }

    // if the test has an inject URL, request it and inject it
    if (options.injectServer) {
      var injectUrl = options.injectServer + '?file=' + test.file; // TODO: sanitize the injectUrl

      request(injectUrl, function (err, res, body) {
        if (err) {
          grunt.log.error('Inject server request failed', err);
          if (typeof body !== 'string') {
            body = '';
          }
        }

        render(injectHTML + body);
      });
    } else {
      // no inject url, so we have all the inject HTML we need, most tests go here, just render the response
      render(injectHTML);
    }
  });

  return app;
};
