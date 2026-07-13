(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor;
var HintPlugin;
var start, selectedTab, runMode;
var autoRun  = false;
var isConsoleOpen = false;
var isGraphicOpen = false;
var jqconsole;
var trinketFiles = {};
var GUID     = TrinketIO.import('utils.guid');
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');
var defaultCode = "Web VPython " + trinketAppConfig.version + "\n";

function getErrorData(error) {
  var match = error.toString().match(/^(.*?)[:;]\s*(.*?)(?:on\sline\s(\d+).*)?$/i);

  // error must at least have type and message
  if (!match || !match[1] || !match[2]) {
    return false;
  }

  return {
    error     : match[0]
    , type    : match[1]
    , message : match[2]
    , line    : match[3] ? parseInt(match[3]) : -1
  };
}

function initConsoleOutput($output) {
  if (isConsoleOpen) return;

  isConsoleOpen = true;
  $('#console-wrap').removeClass('hide');
  if (isGraphicOpen) {
    showSplitOutput();
  }
  else {
    $('#console-wrap').css('height', '100%');
  }

  jqconsole = $('#console-output').jqconsole();
  jqconsole.Write('Powered by <img src="' + trinketConfig.prefix('/img/trinket-logo.png') + '">\n', 'jqconsole-header', false);
}

function showSplitOutput() {
  if ($('#output-dragbar').hasClass('hide')) {
    $('#output-dragbar').removeClass('hide');
    var containerHeight = $('.trinket-content-wrapper').height();
    var dragbarHeight   = $('#output-dragbar').height();
    var topHeight    = (containerHeight*.8) - dragbarHeight/2;
    var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
    $('#graphic-wrap').css('height', topHeight);
    $('#console-wrap').css('height', bottomHeight);
  }
}

function resetOutput() {
  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Write('Powered by <img src="' + trinketConfig.prefix('/img/trinket-logo.png') + '">\n', 'jqconsole-header', false);
  }
  $('#graphic').empty();
  $('#graphic').removeData("graphicMode");
}

/**
 * Run code using local sandboxed iframe (srcdoc)
 */
function runCodeLocal(html) {
  $('#glowscriptIframeContainer').empty();
  var sandboxAttr = trinketSandboxConfig.localPermissions || 'allow-scripts allow-forms allow-modals allow-popups';
  var $iframe = $('<iframe>', {
    id: 'glowscriptOutput',
    sandbox: sandboxAttr
  });
  $iframe.attr('srcdoc', html);
  $('#glowscriptIframeContainer').append($iframe);

  $iframe.one('load', function() {
    $('#loadingContent').hide();
    $('#glowscriptOutput').focus();
  });
}

/**
 * Run code using external sandbox server
 */
function runCodeExternal(html) {
  var sandboxUrl = trinketSandboxConfig.protocol + '://' + trinketSandboxConfig.subdomain + trinketSandboxConfig.domain + '/';
  var files = { 'index.html': html };

  $.post(sandboxUrl, {files: files})
    .done(function(data, status) {
      if (status === "success") {
        $('#glowscriptIframeContainer').empty();
        $('#glowscriptIframeContainer').html("<iframe id='glowscriptOutput' src='" + sandboxUrl + data.token + "/index.html'></iframe>");
        $('#glowscriptOutput').one('load', function() {
          $('#loadingContent').hide();
          $('#glowscriptOutput').focus();
        });
      }
    });
}

function runCode() {
  $('.reveal-modal').foundation('reveal', 'close');

  var $graphic = $('#graphic')
      , files = editor.getAllFiles()
      , serializedCode = api.getValue()
      , prog, key, $hiddenFile;

  for(key in trinketFiles) {
    delete trinketFiles[key];
  }

  $('.hidden-file').remove();

  for(key in files) {
    if (key === "main.py") {
      prog = files[key];
    }
    else {
      // add python files to our list of importable modules
      if (key.match(/\.py$/)) {
        // add a terminal newline to keep skulpt happy
        trinketFiles['./' + key] = files[key] + "\n";
      }
      // create a hidden textarea to allow open('filename', 'r') calls
      if (!$('#' + key).length) {
        $hiddenFile = $('<textarea>', {
          id: key
          // add a terminal newline to ensure that entire contents
          // will be read by skulpt
          , text: files[key] + "\n"
          , "class":"hide hidden-file"
        });
        $('body').append($hiddenFile);
      }
    }
  }

  resetOutput();

  if ($('#statusMessages').children().length) {
    $('#statusMessages').trigger('close.fndtn.alert').remove();
  }

  if (typeof api.beforeRun === 'function') {
    prog = api.beforeRun(prog);
  }

  var active = document.activeElement;

  // pull version from first line or use default from config
  var version  = trinketAppConfig.version;
  var versionStringAdded = false;

  // default language
  var language = "VPython";

  var progLines = prog.split(/\n/);

  // import version string update: v3+ requires the version string to be present
  // in the source whereas earlier versions required it to be stripped out

  // GlowScript [major.minor] [lang]
  if (/^GlowScript/.test(progLines[0])) {
    var match = progLines[0].match(/^GlowScript (\d\.\d) (\w+)/);
    if (match) {
      // verify these are valid
      version  = match[1];
      language = match[2];

      if (parseFloat(version) < 3.0) {
        prog = progLines.slice(1).join("\n");
      }
    }
  }
  else if (/^Web VPython/.test(progLines[0])) {
    var match = progLines[0].match(/^Web VPython (\d\.\d)/);
    if (match) {
      version = match[1];
    }
  }
  // if no version specified and default >= 3, add version string
  else if (parseFloat(version) >= 3.0) {
    prog = ["GlowScript " + version + " " + language, prog].join("\n");
    versionStringAdded = true;
  }

  if (!trinketAppConfig.versionMap[version]) {
    api.showMessage('alert', 'Invalid version of GlowScript.');
    return;
  }

  language = language.toLowerCase();

  var prefix         = trinketAppConfig.prefix;
  var trinketVersion = trinketAppConfig.versionMap[version].trinket;
  var glowscriptPath = trinketAppConfig.versionMap[version].path;
  var jquerySrcs     = _.map(trinketAppConfig.versionMap[version].jquerySrcs, function(src) {
    return "<script src='" + src + "'></script>";
  });

  var glowscriptTextarea = 'block';
  if (runMode && runMode === 'calculator' && (trinketVersion === '3.2.2' || parseFloat(trinketVersion) > 3.2)) {
    glowscriptTextarea = 'none';
  }

  var glowscriptHtml = template('glowscriptTemplate', {
    prog       : prog,
    url        : trinketAppConfig.url,
    domain     : trinketAppConfig.domain,
    path       : glowscriptPath,
    prefix     : prefix,
    lang       : language,
    runMode    : runMode,
    version    : trinketVersion,
    versionStringAdded: versionStringAdded,
    jqueryList : jquerySrcs.join("\n"),
    glowscriptTextarea : glowscriptTextarea
  });

  $("#loadingContent").show();

  // Choose rendering mode based on configuration
  if (trinketSandboxConfig.mode === 'local') {
    runCodeLocal(glowscriptHtml);
  } else {
    runCodeExternal(glowscriptHtml);
  }

  // if this is not an autorun and the dom focus has not changed
  // during the script execution then re-focus the editor
  if (!autoRun && active === document.activeElement) {
    if ($('#editor').css('display') != 'none') {
      api.focus();
    } else {
      $('#honeypot').focus();
    }
  }
  
  api.updateMetric('runs', serializedCode);
  if (!codeRuns[serializedCode] && api.isModified()) {
    api.sendAnalytics('Interaction', {
      action   : 'Modify',
      label    : 'Code'
    });
  }

  api.markCodeAsRun(serializedCode);
};

(function() {
  // prevent backspace from going back in browser history
  var inputTypes = /^(input|text|password|file|email|search|date)$/i;
  $(document).bind('keydown', function (event) {
    var doPrevent = true
        , d;
    if (event.keyCode === 8) {
      d = event.srcElement || event.target;
      if (d.tagName.toLowerCase() === 'textarea' || (d.tagName.toLowerCase() === 'input' && d.type.match(inputTypes))) {
        doPrevent = d.readOnly || d.disabled;
      }

      if (doPrevent) {
        event.preventDefault();
      }
    }
  });
})();

window.TrinketAPI = {
  initialize : function(trinket) {
    api   = this;

    start = $('#start-value').val();
    runMode = $('#runMode-value').val();
    autoRun = (start === 'result');

    var uiType = api.getUIType();

    editor = $('#editor').codeEditor({
        showTabs     : !this._queryString.outputOnly
      , addFiles     : false
      , tabSize      : window.userSettings && window.userSettings.pythonTab || 2
      , lineWrapping : window.userSettings && window.userSettings.lineWrapping || false
      , noEditor     : !!this._queryString.outputOnly
      , mainFileName : 'main.py'
      , showInfo     : false
      , assets       : false
      , guest        : uiType === 'guest' ? true : false
      , canHideTabs  : api.hasPermission('hide-trinket-files')

        // TODO: must also be owner of this trinket - eventually convert to actual permissions based check on trinket
      , canAddInlineComments : api.hasPermission('add-trinket-inline-comments') && (uiType === 'owner' || api.assignmentFeedback)
      , assignmentViewOnly   : api.assignmentViewOnly
      , userId               : api.getUserId()
      , lang                 : 'glowscript'
      , disableAceEditor     : window.userSettings && window.userSettings.disableAceEditor || false
    }).data('trinket-codeEditor');

    $(document).on('open.fndtn.alert', function() {
      editor.resize();
    });
    $(document).on('close.fndtn.alert', function() {
      editor.resize();
    });

    editor.addCommand(
      'run',
      {win: "Ctrl-Enter", mac: "Command-Enter"},
      function(editor) {
        $('#editor').trigger('trinket.code.run', {
          action : 'code.run'
        });
      }
    );

    try {
      HintPlugin = TrinketIO.import('python.editor.hints');
      editor.registerPlugin(HintPlugin);
    } catch(e) {}

    this._errorGroup    = 0;
    this._sessionId     = GUID();
    this._previousError = undefined;

    $(document).on('trinket.code.edit', $.proxy(this.showCode, this));
    $(document).on('trinket.code.run',  $.proxy(this.showResult, this));

    $(document).on('trinket.output.view',       $.proxy(api.showOutput, api));
    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    $('#editorToggleWrapper').keydown($.proxy(this.editorToggleFieldset, this));
    $('#toolbarEditorToggle').change($.proxy(this.toolbarEditorToggle, this));

    this.viewer = '#codeOutput';
    $(document).on('trinket.code.help', $.proxy(this.toggleHelp, this));

    if (!this._queryString.outputOnly) {
      $('#honeypot').on('keydown', $.proxy(this.showCode, this));
    }

    $('#menu').on(
      'trinket.sharing.share trinket.sharing.embed trinket.sharing.email',
      function(evt) {
        if (api.isModified() && !codeRuns[api.getValue()]) {
          $('#runFirstModal').foundation('reveal', 'open');
          evt.preventDefault();
        }
      }
    );

    $('.menu-toolbar .menu-button[data-action="code.run"]').on('mousedown', function(event) {
      if (editor && editor.isFocused()) {
        event.preventDefault();
      }
    });

    $('#modalRun').click(function() {
      sendInterfaceAnalytics(this);
      $('#runFirstModal').foundation('reveal', 'close');
      runCode();
    });

    if (this._queryString.addDefaultCode && !trinket.code) {
      trinket.code = defaultCode;
      api.setTrinket(trinket, true);
      api.reset(trinket);
      var lines = defaultCode.split("\n");
      editor.gotoLine(lines.length);
    }
    else {
      api.reset(trinket);
    }

    editor.change(function() {
      api.triggerChange();
    });

    api.draggable();

    $('#output-dragbar').mousedown(function(e) {
      e.preventDefault();

      var containerHeight = $('.trinket-content-wrapper').height();
      var containerTop    = $('.trinket-content-wrapper').offset().top;
      var dragbarHeight   = $('#output-dragbar').height();
      $(document).on('mousemove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight/2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);
        }
      });

      $(document).on('mouseup.output-dragbar', function(e) {
        $(document).off('mousemove.output-dragbar mouseup.output-dragbar');
      });

      api.sendInterfaceAnalytics(this);
    });

    api.activityLog = new ActivityLog(function(type, count) {
      var action = type.replace(
        /[a-zA-Z0-9](?:[^\s\-\._]*)/g
        , function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1);}
      );
      api.sendAnalytics("Output", {
        action  : action
        , label : api.getTrinketIdentifier()
        , value : count
      });
    });

    window.addEventListener('message', function(e) {
      var data;

      try {
        data = JSON.parse(e.data);
      } catch(e) {}

      if (data && data["glowscript.error"]) {
        api.showMessage('alert', data["glowscript.error"]);
      }
    });

    if (api._queryString && api._trinket.description && api._queryString.showInstructions && api._trinket.description.length) {
      $(document).trigger('trinket.instructions.view');
    }
  },

  getTour : function() {
    var ui   = this.getUIType(),
        tour = [];

    if (ui !== 'owner') {
      // check if this is a small screen
      if ($('.mode-toolbar .show-for-small-only').css('display') !== 'none') {
        // check if starting in code view
        if (!$('#editor').hasClass('hide')) {
          tour.push({el:'.run-it', event:'code.run'});
        }
        tour.push(
          {el:'.edit-it', event:'code.edit'},
          {el:'.ace_content', event:'code.change'},
          {el:'.run-it', event:'code.run'}
        );
      }
      else if ($('#start-value').val() === "result" || !this._trinket.code) {
        tour.push(
          {el:'.ace_content', event:'code.change'},
          {el:'.run-it', event:'code.run'}
        );
      }
      else {
        tour.push([
          {el:'.run-it', event:'code.run'},
          {el:'.ace_content', event:'code.change'}
        ]);
      }

      tour.push(
        {el:'.left-menu-toggle', event:'menu.options'},
        {el:'.share-it', event:'sharing.share'}
      );

      if (ui === 'guest') {
        tour.push({el:'.right-menu-toggle', event:'menu.user'});
      }

      tour.push({el:'.save-it', event:'library.add'});
    }

    return tour;
  },
  getEditor : function() {
    return editor;
  },
  getType : function() {
    return 'glowscript';
  },
  getValue : function(opts) {
    return editor.serialize(opts);
  },
  getAnalyticsCategory : function() {
    return 'GlowScript';
  },
  serialize : function(opts) {
    var serialized = {
      code     : this.getValue(opts),
      settings : this._trinket.settings
    };

    if (opts && opts.removeComments) {
      editor.removeComments();
    }

    return serialized;
  },
  showMessage : function(type, message) {
    var html = template('statusMessageTemplate', {
      type    : type,
      message : message
    });
    var $msg = $(html);
    $('body').addClass('has-status-bar').append($msg);
    $msg.parent().foundation().trigger('open.fndtn.alert');
  },
  showCode : function(event) {
    $('#codeOutput').addClass('hide');
    $('#editor').removeClass('hide');
    api.closeOverlay('#help');
    api.focus();
  },
  showResult : function(event) {
    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    api.closeOverlay('#help');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');

    runCode();
    if (event) {
      api.sendAnalytics('Interaction', {
        action   : 'Click',
        label    : 'Run'
      });
    }
  },
  toggleHelp : function() {
    if ($('#glowscriptExample').hasClass("hide")) {
      var highlighted = hljs.highlight('python', $('#glowscriptExample').text()).value;
      $('#glowscriptExample').replaceWith("<code class='hljs'>" + highlighted + "</code>");
    }
    api.toggleOverlay('#help');
  },
  saveClientSnapshot : function() {
    return true;
  },
  captureAndSaveSnapshot : function(done) {
    var doneCalled = false;

    // The snapshot iframe (#glowscriptOutput) only exists after the program
    // has been run. If the user saves without running first, skip the snapshot
    // rather than throwing on undefined.contentWindow — an unhandled throw here
    // aborts the post-save callback, so the trinket saves on the server but the
    // UI never completes (no navigation/feedback), looking like "save failed".
    var output = $('#glowscriptOutput')[0];
    if (!output || !output.contentWindow) {
      done();
      return;
    }

    var snapshotHandler = function(event) {
      var data;

      try {
        data = JSON.parse(event.data);
      } catch(e) {}

      // make sure event listener only called once
      window.removeEventListener('message', snapshotHandler);

      if (data && data.snapshot) {
        done(data.snapshot);
      }
      else {
        done();
      }

      doneCalled = true;
    }

    // setup event listener
    window.addEventListener('message', snapshotHandler);

    // post message to iframe to take snapshot
    output.contentWindow.postMessage('glowscript.snapshot', '*');

    // ensure done is called
    setTimeout(function() {
      if (!doneCalled) {
        done();
      }
    }, 2000);
  },
  hideAll : function() {
    this.toggleHelp();
  },
  onOpenOverlay : function() {
    $('#codeOutput').addClass('hide');
    $('#editor').addClass('hide');
  },
  onCloseOverlay : function() {
    $('#codeOutput').removeClass('hide');
    $('#editor').removeClass('hide');
    api.focus();
  },
  reset : function(trinket) {
    editor.reset(trinket.code);
    if (trinket.code && (start === 'result')) {
      this.showResult();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  focus : function() {
    if (!$('body').data('is-mobile') && $('body').data('autofocus')) {
      editor.focus();
    }
  },
  markCodeAsRun : function(code) {
    codeRuns[code] = true;
  },

  setWrap: function(wrap) {
    editor.setWrap(wrap)
    this.setAPILineWrap(wrap)
  },

  setIndent: function(indent) {
    editor.setIndent(indent);
    this.setAPIIndent(indent, undefined, undefined, undefined);
  },

  toolbarEditorToggle : function(event) {
    if ($(event.target).is(':checked')) {
      editor.option('disableAceEditor', true);
    }
    else {
      editor.option('disableAceEditor', false);
    }
    editor.refresh();
  },
  editorToggleFieldset : function(event) {
    var keycode = (event.keyCode ? event.keyCode : event.which);
    if (event.target.id === 'editorToggleFieldset' && keycode === 32) {
      $('#toolbarEditorToggle').prop('checked', !$('#toolbarEditorToggle').is(':checked'));
      if ($('#toolbarEditorToggle').is(':checked')) {
        editor.option('disableAceEditor', true);
      }
      else {
        editor.option('disableAceEditor', false);
      }
      editor.refresh();
    }
  },

};

})(window, window.TrinketIO);
