$('document').ready(function() {
  var $            = window.jQuery;
  var TrinketIO    = window.TrinketIO;
  var EXPIRES      = 20 * 24 * 60 * 60; // 20 days in seconds
  var storage      = TrinketIO.import('utils.cache');
  var template     = TrinketIO.import('utils.template');
  var selectText   = TrinketIO.import('utils.selectText');
  var shareOptions = TrinketIO.import('trinket.share');
  var Roles        = TrinketIO.import('trinket.roles');
  var parser       = typeof trinketMarkdown !== 'undefined' ? trinketMarkdown({}) : undefined;
  var instructionsEditor;

  storage.purge();

  $.fn.serializeObject = function() {
    var o = {};
    var a = this.serializeArray();
    $.each(a, function() {
      if (o[this.name]) {
        if (!o[this.name].push) {
          o[this.name] = [o[this.name]];
        }
        o[this.name].push(this.value || '');
      } else {
        o[this.name] = this.value || '';
      }
    });
    return o;
  };

  var MODES = {
    interact : {
      icon  : 'fa-hand-o-up',
      title : 'interactive mode'
    },
    edit : {
      icon  : 'fa-pencil',
      title : 'edit mode'
    }
  };

  function qualifyUrl(url) {
    return window.location.protocol + '//' + window.location.host + url;
  }

  function decodeHash(hash) {
    var params = hash.split('=')
        , code = ''
        , parseInteractive = false
        , multifileRegex, files, mainName, mainMatch, i;

    if (this.getType() === 'console'
    || ((this.getType() === 'python3' || this.getType() === 'python') && this._queryString.runMode === 'console')) {
      parseInteractive = true;
    }

    if (params[0] === 'code' && params[1]) {
      code = decodeURIComponent(params[1]);

      // if java, check for different main file name
      if (this.getType() === 'java') {
        mainMatch = code.match(/^----\{(\w[\w\.\-]*)\}----\n/);
        if (mainMatch) {
          mainName = mainMatch[1];

          // strip off first line (main file name)
          code = code.substring(code.indexOf('\n') + 1);
        }
      }

      // check for multi-file
      multifileRegex = /\n----\{(\w[\w\.\-]*)\}----\n/;
      files = code.split(multifileRegex);

      if (files.length > 1 || mainName) {
        mainName = mainName || this.getMainFile();
        if (mainName) {
          code = [{
              name    : mainName
            , content : files.shift()
          }];

          // only the first line could be interface if multi-file
          if (parseInteractive) {
            code[0].content = _parseInteractive(code[0].content);
          }

          for (i = 0; i < files.length; i += 2) {
            code.push({
                name    : files[i]
              , content : typeof files[i + 1] !== 'undefined' && files[i + 1].length ? files[i + 1] : ''
            });
          }

          code = JSON.stringify(code);
        }
      }
      else if (parseInteractive) {
        code = _parseInteractive(code);
      }
    }

    return code
  }

  function _parseInteractive(code) {
    var consoleCode, consoleLines, prompt, cmd;

    // if code starts with >>>
    // all lines must be from an interactive session
    // other lines will not be included
    if (/^>>>/.test(code)) {
      consoleCode  = [];
      consoleLines = code.split('\n');
      consoleLines.forEach(function(line) {
        if (prompt = /^(>>>|\.\.\.) /.exec(line)) {
          cmd = line.substring(4, line.length);
          if (prompt[1] === '...') {
            consoleCode[consoleCode.length - 1] += '\\n' + cmd;
          }
          else if (typeof cmd !== 'undefined' && cmd.length) {
            consoleCode.push(cmd);
          }
        }
      });

      code = consoleCode.join('\n');
    }

    return code;
  }

  function unescapeJSON(data) {
    if (typeof data === 'undefined' || data === null) {
      return null;
    }

    if (data instanceof Array) {
      for (var i = 0; i < data.length; i++) {
        data[i] = unescapeJSON(data[i]);
      }
    }
    else if (typeof data === 'object') {
      for (var i in data) {
        if (data.hasOwnProperty(i)) {
          data[i] = unescapeJSON(data[i]);
        }
      }
    }
    else if (typeof data === 'string') {
      // this is using lodash, same as server
      data = _.unescape(data);
    }

    return data;
  }

  function queryString() {
    var values = {};
    if (window.location.search) {
      var params = window.location.search.substr(1).split('&');
      for (var i = 0; i < params.length; i++) {
        var p = params[i].split('=');
        if (p[0] && typeof(p[1]) !== 'undefined') {
          values[p[0]] = decodeURIComponent(p[1].replace(/\+/g, " "));
          if (values[p[0]] === "true") values[p[0]] = true;
          if (values[p[0]] === "false") values[p[0]] = false;
        }
      }
    }
    return values;
  }

  function runtimeSettings(settingsObj, clearFirst) {
    if (clearFirst) {
      TrinketIO.clearRuntime();
    }

    var settings = Object.keys(settingsObj);
    settings.forEach(function(setting) {
      TrinketIO.runtime(setting, settingsObj[setting]);
    });
  }

  function makeAccountCall(url, api) {
    return function(event, eventForm, eventOptions) {
      var data = eventForm ? $(eventForm).serialize() : $("#accountForm").serialize();
      var form = eventForm || "#accountForm";
      var options = eventOptions || null;
      event.stopPropagation();
      event.preventDefault();
      $.ajax({
        type : 'POST',
        url  : url,
        data : data,
        success : $.proxy(api.onLoginComplete, api, form),
        dataType : 'json'
      });

      api.sendInterfaceAnalytics(this, eventOptions);
    };
  }

  function deferredAddZip(url, filename, zip) {
    var deferred = $.Deferred();
    JSZipUtils.getBinaryContent(url, function (err, data) {
      if (err) {
        deferred.reject(err);
      }
      else {
        zip.file(filename, data, { binary : true });
        deferred.resolve(data);
      }
    });
    return deferred;
  }

  function TrinketApp(trinketObject, draftObject) {
    var self           = this,
        eventDelegates = ['on', 'off', 'trigger', 'once'],
        viewOnly       = $('body').data('view-only'),
        updateDraft, autoSave, partnerAutoSave;

    self._timing = {
      t0 : performance.now()
    };

    // simple object for storing/passing variables
    self._varProxy = {};

    this._$ = $(this);
    // proxy event handling to jquery methods
    for(var i = 0; i < eventDelegates.length; i++) {
      var method = eventDelegates[i];
      this[method] = $.proxy(this._$[method], this._$);
    }

    this.$shareModal = $('#shareModal');
    this.$shareUrl   = $('#shareUrl');
    this.$embedModal = $('#embedModal');
    this.$embedCode  = $('#embedCode');
    this.$emailModal = $('#emailModal');
    this.$overlay    = $('#content-overlay');
    this.$resetModal = $('#confirmResetModal');

    this.$upgradeModal = $('#upgradeModal');
    this.$draftMessage = $('#draftMessage');
    this.assignment    = $('body').data('assignment');
    this.assignmentFeedback = $('body').data('assignment-feedback');
    this.assignmentViewOnly = $('body').data('view-only');

    this.partner = $('body').data('partner');

    this.$responsiveIndicators = $('.responsive-indicator');

    this.draftSavedText = $('body').data('draft-saved-text') || 'Draft saved';
    this.initialFontSize = $('body').data('initial-font-size') || '1em';

    $(document).on('click', '#noVNC_keyboardbutton', function(evt) {
      // noVNC_keyboardinput
      var action = $(this).data('action');
      var type   = 'trinket.' + action;
      console.log('type:', type);
      $(this).trigger(type, {
        action   : action,
        data     : $(this).data('data')
      });
    })

    $(document).on('click touchstart keypress', '.menu-button', function(evt) {
      if (evt.type === 'keypress') {
        var keycode = (evt.keyCode ? evt.keyCode : evt.which);
        if (keycode !== 13) {
          return;
        }
      }

      var action = $(this).data('action');

      var type   = 'trinket.' + action;

      if ($(this).hasClass('disabled')) return;

      if (evt.type === 'touchstart') {
        $(this).addClass('touched');
      }
      else if (evt.type === 'click' && $(this).hasClass('touched')) {
        $(this).removeClass('touched');
        return;
      }

      $(this).trigger(type, {
        action   : action,
        data     : $(this).data('data')
      });

      if (!$(this).data('no-analytics')) {
        self.sendInterfaceAnalytics(this);
      }
    });

    $(document).on('trinket.sharing.share', $.proxy(this.onShareClick, this));
    $(document).on('trinket.sharing.embed', $.proxy(this.onEmbedClick, this));
    $(document).on('trinket.sharing.email', $.proxy(this.onEmailClick, this));
    $(document).on('trinket.library.add',   $.proxy(this.onSaveClick, this));
    $(document).on('trinket.code.save',     $.proxy(this.onUpdateClick, this));
    $(document).on('trinket.code.fontsize', $.proxy(this.onFontSizeClick, this));
    $(document).on('trinket.view.gallery',  $.proxy(this.onGalleryClick, this));
    $(document).on('trinket.mode.fullscreen', $.proxy(this.onFullScreenClick, this));
    $(document).on('trinket.mode.download', $.proxy(this.onDownloadClick, this));
    $(document).on('trinket.mode.upload',   $.proxy(this.onUploadClick, this));
    $(document).on('trinket.menu.upgrade',  $.proxy(this.onUpgradeClick, this));
    $(document).on('trinket.open.link',     $.proxy(this.onLinkClick, this));
    $(document).on('trinket.code.reset',    function() {
      self.$resetModal.foundation('reveal', 'open');
    });
    $(document).on('trinket.code.confirm-reset', $.proxy(this.onResetClick, this));
    $(document).on('trinket.code.cancel-reset', function() {
      self.$resetModal.foundation('reveal', 'close');
    });
    $(document).on('trinket.code.settings', function() {
      $('#settingsModal').foundation('reveal', 'open');
    });

    $(document).on('trinket.keyboard.toggle', $.proxy(this.onKeyboardToggle, this));

    $('#code-editorfocus').keyup(function(event) {
      var keycode = (event.keyCode ? event.keyCode : event.which);
      if (keycode === 13) {
        event.stopPropagation();
        event.preventDefault();
        self.goToStart();
        return false;
      }
    });

    $(document).on('webkitfullscreenchange mozfullscreenchange fullscreenchange MSFullscreenChange', function(event) {
      var wrapper_width = $('.trinket-content-wrapper').width();
      var editor_width  = $('#editor').width();
      if (editor_width > wrapper_width) {
        $('#editor').css('width', wrapper_width * .5);
      }
    });

    $(document).on('trinket.sharing.social', function(event, data) {
      var makeTrinket = false,
          timestamp, shortCodeSeed;

      // trigger the a click on the appropriate social add-this button
      $(data.data).click();

      if (makeTrinket) {
        var options    = {},
            serialized = self.serialize(),
            done       = function() {};

        serialized.shortCode  = self._trinket.shortCode;
        serialized._timestamp = timestamp;

        self._trinket.id
          ? self.fork(self._trinket, serialized, options, done)
          : self.create(serialized, options, done);
      }
    });

    $(document).on('trinket.account.login',  makeAccountCall('/api/users/login', this));
    //$(document).on('trinket.account.create', makeAccountCall('/api/users',       this));

    $('#brand').click($.proxy(this.onLogoClick, this));
    $('#shareUrl').click($.proxy(this.onShareFocus, this));
    $('#embedCode').click($.proxy(this.onEmbedFocus, this));

    $(document).on('change', 'input[data-trinket-settings]', $.proxy(this.settingsChange, this));
    $('#lineWrapping').on('change', $.proxy(this.lineWrappingChange, this));
    $('#indentationAmount').on('change', $.proxy(this.indentChange, this));

    TrinketIO.runtime('settingsModified', false);

    shareOptions.init();

    $("#version-toggle").change( function(){
      if( $(this).is(':checked') ) {
        self.reset(self._original);
        self._viewingOriginal(false);
        $('.menu-button').not('.allow-original').removeClass('disabled');
      }
      else {
        $.extend(true, self._original, self.serialize());
        self.reset(self._original.original);
        self._viewingOriginal(true);
        $('.menu-button').not('.allow-original').addClass('disabled');
        $('.revert-remix').removeClass('disabled');
      }
    });

    this._notification_open = false;
    $('#notification-container').click($.proxy(this.onNotificationClick, this));

    this._currentMode = '';
    this._updates  = {};

    this._original = unescapeJSON(trinketObject);

    this._viewingDraft = false;
    this._predraft     = $.extend(true, {}, this._original);
    if (draftObject) {
      this._original_draft = unescapeJSON(draftObject);
      ['code', 'assets', 'settings'].forEach(function(key) {
        if (self._original_draft[key]) {
          self._original[key] = self._original_draft[key];
          self._viewingDraft  = true;

          if (key === 'settings') {
            runtimeSettings(self._original_draft[key] || {});
          }
        }
      });

      if (this._viewingDraft) {
        var html = template('draftTextTemplate', {
          draftText : 'Viewing Draft'
        });
        this.$draftMessage.html(html);

        $('.save-it').removeClass('disabled');
      }
    }
    else {
      runtimeSettings(this._original.settings || {});
    }

    this._queryString = queryString();

    if (window.location.hash) {
      // location.hash has a bug in firefox (partially decoded)
      // so we use href and grab the hash portion instead
      var url  = window.location.href; // the href is unaffected by the Firefox bug
      var code = decodeHash.call(this, url.substr(url.indexOf('#')+1));
      if (code) {
        this._original.code = code;
      }
    }

    this.setTrinket(this._original);

    try {
      window.sessionStorage;
    } catch(e) {
      this._queryString.noStorage = true;
    }

    // allows an external source to reset storage without confirmation
    if (this._queryString.clearStorage) {
      this.generateGUID();

      try {
        window.sessionStorage && window.sessionStorage.removeItem(this.guid);
        storage.remove(this.guid);
      } catch(e) {}
    }

    if (!this._queryString.noStorage && !this._queryString.outputOnly) {
      this.generateGUID();

      if (this._queryString.autoRestore !== false && window.sessionStorage && window.sessionStorage.getItem(this.guid)) {
        this._trinket.code = window.sessionStorage.getItem(this.guid);
        if (window.parent) {
          window.parent.postMessage("autorestored", "*");
        }
      }
      else if (this._previousSession = storage.get(this.guid)) {
        storage.remove(this.guid);

        if (this._queryString.autoRestore !== false) {
          this._trinket.code = this._previousSession;
          if (window.parent) {
            window.parent.postMessage("autorestored", "*");
          }
        }
        else {
          self.showRestoreMessage();
        }
      }
    }

    this.setUI();

    if ( this.getType() !== 'console'
      && this.getUIType() !== 'guest'
      && !this.assignment && !viewOnly // not an assignment
      && this._original && this._original.id
    ) {
      updateDraft = true;
    }

    // an assignment but not viewing a previous submission
    if ( this.assignment && !viewOnly ) {
      autoSave = true;
    }
    else if (this.partner) {
      this.partnerAutoSave = true;
    }

    if (updateDraft) {
      $(this).on('trinket.code.change', _.debounce(function() {
        $('.save-it').removeClass('disabled');
        self.updateDraft();
      }, trinket.config.draftDebounce));
    }
    else if (autoSave || this.partnerAutoSave) {
      $(this).on('trinket.code.change', _.debounce(function() {
        $('.save-it').removeClass('disabled');
        self.autoSave();
      }, trinket.config.autosaveDebounce));
    }
    else {
      $(this).on('trinket.code.change', _.debounce(function() {
        self.updateSessionCache();
      }, 500));
    }

    if (!this._queryString.externalInit) {
      this.initialize(this._trinket);
    }

    this.toggleUI(this.getUIType());

    $(document).keydown(function(e){
      // close overlays when ESC is pressed
      if (self.hasOverlay && e.keyCode === 27) {
        self.hideAll();
      }
    });

    $(document).foundation({
      offcanvas : {
        close_on_click : true
      }
      , dropdown: {
        // specify the class used for active dropdowns
        active_class: "open"
      }
    });

    $('#settingsModal').on('opened', function() {
      self.settingsLastActive = document.activeElement;
      $('#toggleEditor').focus();
    });
    $('#settingsModal').on('closed', function() {
      self.goToStart();
    });

    // for iDevices
    $(".left-off-canvas-toggle, .right-off-canvas-toggle").on("click", function() { });

    $(document).on('close.fndtn.alert', function(event) {
      $('body').removeClass('has-status-bar');
    });

    this.setFontSize(this._queryString.font || this.initialFontSize);

    // commented out 2017/04/04 to help improve performance -bpm
    // this.startTour();

    this.parsedInstructions = "";
    $(document).on('click', '#edit-instructions-link', $.proxy(this.onEditInstructionsClick, this));
    $(document).on('click', '#cancel-edit-instructions', $.proxy(this.onCancelEditInstructionsClick, this));
    $(document).on('click', '#save-instructions', $.proxy(this.onSaveInstructionsClick, this));

    // serverside delay - 10 minutes for connect subscribers, 3 minutes otherwise
    self.serversideTimeoutDelay = self.hasPremiumTrinkets() ? 600000 : 180000;

    self.hasRun = false;
  }

  function showStatusBar(msg, yep, nope, type) {
    var html = template('statusMessageTemplate', {
      type    : type || 'success',
      message : msg
    });
    var $msg = $(html);

    $('body').addClass('has-status-bar').append($msg);
    if (yep) {
      $msg.find('.yep').on('click', yep);
    }
    if (nope) {
      $msg.find('.nope').on('click', nope);
    }
    $(document).foundation('alert', 'reflow');
  }

  function usingModule(files, module, ext) {
    var usingModule = false
      , extRegex    = new RegExp('\\.' + ext)
      , importOne   = new RegExp('import\\s*' + module)
      , importTwo   = new RegExp('from\\s*' + module + '\\s*import');

    _.map(files, function(contents, name) {
      if (name.match(extRegex) && (contents.match(importOne) || contents.match(importTwo))) {
        usingModule = true;
      }
    });

    return usingModule;
  }

  $.extend(TrinketApp.prototype, {
    setAPILineWrap : function(wrap) {
      $.post(
        "/api/users/settings/lineWrapping",
        {lineWrapping: wrap}
      )
    },
    setAPIIndent : function(python, html, r, java) {
      if (python == undefined) {python = window.userSettings.pythonTab != undefined ? window.userSettings.pythonTab : 2}
      if (html   == undefined) {html   = window.userSettings.htmlTab   != undefined ? window.userSettings.htmlTab   : 2}
      if (r      == undefined) {r      = window.userSettings.rTab      != undefined ? window.userSettings.rTab      : 2}
      if (java   == undefined) {java   = window.userSettings.javaTab   != undefined ? window.userSettings.javaTab   : 2}
      $.post(
        "/api/users/settings/indentation",
        {
          pythonTab : python,
          htmlTab   : html,
          rTab      : r,
          javaTab   : java
        }
      );
    },
    showRestoreMessage : function() {
      var self = this,
        originalCode, restoreMsg, keepMsg;

      restoreMsg = 'Do you want to restore your last session? <a title="restore the previous session" data-action="code.restore" class="text-link yep"><i class="fa fa-check"></i>&nbsp;Restore</a>&nbsp;&nbsp;or&nbsp;&nbsp;<a class="text-link nope"><i class="fa fa-trash"></i>&nbsp;Discard</a>';
      keepMsg    = '<i class="fa fa-check-circle-o"></i>&nbsp;Your session has been restored. <a class="text-link yep"><i class="fa fa-thumbs-o-up">&nbsp;</i>Accept</a>&nbsp;&nbsp;or&nbsp;&nbsp;<a class="text-link nope"><i class="fa fa-undo"></i>&nbsp;Undo</a>';
      showStatusBar(restoreMsg, function doRestore() {
        $('#statusMessages .close').click();
        originalCode = self._trinket.code;
        self._trinket.code = self._previousSession;
        self.reset(self._trinket);
        $(self).trigger("trinket.code.change");

        showStatusBar(keepMsg, function keepRestore() {
          $('#statusMessages .close').click();
        }, function undoRestore() {
          $('#statusMessages .close').click();
          self._trinket.code = originalCode;
          self.reset(self._trinket);
          $(self).trigger("trinket.code.change");
          self.showRestoreMessage();
        });
      },
      function doDiscard() {
        $('#statusMessages .close').click();
      });
    },
    initialize : function(trinket) {
      throw new Error('initialize is not implemented');
    },
    generateGUID : function() {
      var guidSeed;

      if (this.guid) {
        return;
      }

      var guidSeed  = (this._trinket.id || JSON.stringify(this._trinket)) + (document.referrer || document.location);

      if ($('#user').val()) {
        guidSeed += $('#user').val();
      }

      this.guid = CryptoJS.MD5(guidSeed).toString(CryptoJS.enc.Hex);
    },
    getTour : function() {
      return [];
    },
    startTour : function() {
      this.tour = this.getTour();
      if (this.tour && this.tour.length) {
        this.nextStop();
      }
    },
    nextStop: function() {
      var self = this,
          tour = self.tour,
          stop = tour ? tour.shift() : null,
          pending;

      prepareStop = function(selector, event) {
        $(selector).addClass('attention');
        $(document).one('trinket.' + event, function() {
          $(selector).removeClass('attention');
          if (--pending === 0) {
            self.nextStop();
          }
        });
      }

      if (stop) {
        if (!(stop instanceof Array)) {
          stop = [stop];
        }
        pending = stop.length;
        for(var i = 0; i < stop.length; i++) {
          prepareStop(stop[i].el, stop[i].event);
        }
      }
    },
    onFontSizeClick : function(event, data) {
      this.setFontSize(data && data.data);
    },
    onFullScreenClick : function(event, data) {
      var doc     = document
          , el    = doc.documentElement
          , enter = el.requestFullscreen || el.msRequestFullscreen
                    || el.mozRequestFullScreen || el.webkitRequestFullscreen
          , exit  = doc.exitFullscreen || doc.msExitFullscreen
                    || doc.mozCancelFullScreen || doc.webkitExitFullscreen;
      try {
        if (enter && !doc.fullscreenElement && !doc.mozFullScreenElement
            && !doc.webkitFullscreenElement && !doc.msFullscreenElement) {
          enter.call(el);
          this.sendInterfaceAnalytics(event.target, {data:'enter'});
        }
        else if (exit) {
          exit.call(doc);
          this.sendInterfaceAnalytics(event.target, {data:'exit'});
        }
        else {
          throw new Error('fullscreen unavailable');
        }
      } catch(e) {
        if (confirm('Your browser does not support fullscreen mode. Would you like to open this trinket in a new window?')) {
          var url = window.location.href;
          // if trinket has been modified, keep the modifications when loading
          // the new page by by stuffing them into the hash
          if (this.isModified()) {
            var hash = 'code=' + window.encodeURIComponent(this.getValue());
            url = url.indexOf('#') > 0
              // replace the existing hash
              ? url.replace(url.substr(url.indexOf('#')+1), hash)
              // or add a new hash
              : url + '#' + hash;
          }
          window.open(url);
        }
      }
    },
    onDownloadClick : function(event, data) {
      var downloadable = this.downloadable(),
          self         = this,
          filename;

      // Build filename
      filename = this.getTrinketIdentifier();
      if (this._trinket && this._trinket.name) {
        filename = this._trinket.name + "-" + filename;
      }
      filename = "Trinket Download-" + filename;

      // Track analytics
      self.callAnalytics('Interaction', 'Click', 'Download');

      // Use form POST with hidden iframe target to avoid breaking the page on errors
      var iframeName = 'download-iframe-' + Date.now();
      var iframe = document.createElement('iframe');
      iframe.name = iframeName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      var form = document.createElement('form');
      form.method = 'POST';
      form.action = '/api/trinkets/download';
      form.target = iframeName;
      form.style.display = 'none';

      var filesInput = document.createElement('input');
      filesInput.type = 'hidden';
      filesInput.name = 'files';
      filesInput.value = JSON.stringify(downloadable.files);
      form.appendChild(filesInput);

      var assetsInput = document.createElement('input');
      assetsInput.type = 'hidden';
      assetsInput.name = 'assets';
      assetsInput.value = JSON.stringify(downloadable.assets);
      form.appendChild(assetsInput);

      var filenameInput = document.createElement('input');
      filenameInput.type = 'hidden';
      filenameInput.name = 'filename';
      filenameInput.value = filename;
      form.appendChild(filenameInput);

      document.body.appendChild(form);
      form.submit();

      // Clean up form and iframe after a delay
      setTimeout(function() {
        document.body.removeChild(form);
        document.body.removeChild(iframe);
      }, 5000);
    },
    onUpgradeClick : function(event, data) {
      this.$upgradeModal.foundation('reveal', 'open');
    },
    onLinkClick : function(event) {
      event.preventDefault();
      window.open(qualifyUrl($(event.target).data('href')));
    },
    setFontSize : function(size) {
      $('.trinket-content-wrapper').children().css('font-size', size || this.initialFontSize);
    },
    setUI : function() {
      this._userId = $('#user').val();
      if (!this._userId) {
        this._ui = 'guest';
      }
      else if (this._trinket && this._trinket._owner === this._userId) {
        this._ui = 'owner';
      }
      else if (this._queryString.inLibrary) {
        this._ui = 'library';
      }
      else {
        this._ui = 'user';
      }
    },
    toggleUI : function(type) {
      var self = this,
          markup = template(type+'MenuTemplate');

      $('#userMenu').empty().append(markup).foundation();
      if (type === 'guest') {
        $('#login').click(makeAccountCall('/api/users/login', self));
        //$('#register').click(makeAccountCall('/api/users',    self));
      }

      $('.ui-option')
        .addClass('hide')
        .filter('.' + type + '-option')
        .removeClass('hide');
    },
    getUIType : function() {
      return this._ui;
    },
    getUserId : function() {
      return this._userId;
    },
    hasPermission : function() {
      var args = Array.prototype.slice.call(arguments);
      return Roles.hasPermission.apply(this, args);
    },
    hasRole : function() {
      var args = Array.prototype.slice.call(arguments);
      return Roles.hasRole.apply(this, args);
    },
    hasPremiumTrinkets : function() {
      return this.hasRole("trinket-connect") || this.hasRole("trinket-codeplus");
    },
    triggerChange : function() {
      $(document).trigger('trinket.code.change');
      this.trigger('trinket.code.change');
      if (window.parent && (this.assignment || this._queryString.listen)) {
        window.parent.postMessage(this.serialize(), "*");
      }
    },
    onLoginComplete : function(form, obj, str, req) {
      var self = this;
      if (obj && obj.status === 'success') {
        var requested = $(form + ' input[name="email"]').val()
        window.TrinketIO.import('debug.sessions').onLogin(requested, obj.data);
        this._ui = obj.data.id === this._trinket._owner ? 'owner' : 'user';
        this.toggleUI(this._ui);
        $(document).trigger('trinket.account.success');
        $('body').append("<input id='roles' type='hidden' value='" + obj.data.roles + "'>");

        if (this.getType() !== 'console' && this.getUIType() !== 'guest' && this._original && this._original.id) {
          $(this).off('trinket.code.change');
          $(this).on('trinket.code.change', _.debounce(function() {
            $('.save-it').removeClass('disabled');
            self.updateDraft();
          }, 1000));
        }

        var permission    = "create-" + this.getType() + "-trinket";
        var upgradeNeeded = this.hasPermission(permission) ? false : true;

        if (this._ui === 'owner') {
          $('a.create-remix').data('action', 'code.save');
          $('a.create-remix').attr('title', 'Save changes.');
          $('a.create-remix').find('i').removeClass().addClass('fa fa-save');
          $('a.create-remix').find('label').html('Save');
        }
        else if (!upgradeNeeded) {
          $('a.create-remix').data('action', 'library.add');
        }

        if (!upgradeNeeded) {
          $('a.create-copy').data('action', 'library.add');
          $('a.save-remix').data('action', 'library.add');
          $('a.revert-remix').data('action', 'library.add');
        }
      }
      else if (obj && obj.flash && obj.flash.validation) {
        $(form + ' .message').addClass('error').text(obj.flash.validation.email || obj.flash.validation.password);
      }
      else if (obj && obj.flash && obj.flash.duplicates) {
        $(form + ' .message').addClass('error').text('This email is already registered; try logging in.');
      }
      else if (obj && obj.message) {
        $(form + ' .message').addClass('error').text(obj.message);
      }
      else {
        $(form + ' .message').addClass('error').text('We were unable to log you in; please try again later.')
      }
    },
    updateSessionCache : function() {
      var self = this,
          value = self.getValue();

      // if new value matches the original value, clear the storage
      if (value === self._original.code) {
        try {
          window.sessionStorage && window.sessionStorage.removeItem(self.guid);
          storage.remove(self.guid);
        } catch(e) {}
      } else {
        // allow sets to silently fail
        try {
          window.sessionStorage && window.sessionStorage.setItem(self.guid, value);
          storage.set(self.guid, value, EXPIRES);
        } catch(e) {}
      }
    },
    updateDraft : function() {
      var self = this;

      self.$draftMessage.fadeOut('fast', function() {
        self.$draftMessage.text('Saving Draft').fadeIn('slow', function() {
          self._updateDraft();
        });
      });
    },
    _updateDraft : function() {
      var self = this
        , data = self.serialize()
        , url  = '/api/trinkets/' + self._original.id + '/draft'
        , postData, zip;

      // skips the time to fade In/Out messages
      // used in library when leaving page

      postData = {
          assets   : data.assets
        , settings : data.settings
      };

      zip = new JSZip();
      zip.file("zipCode", JSON.stringify(data.code));

      zip.generateAsync({ type: "base64", compression: "DEFLATE", compressionOptions: { level: 9 } }).then(function(content) {
        postData.zipCode = content;
        $.post(url, postData)
        .done(function(result) {
          if (result.success) {
            self._viewingDraft = true;
            self.$draftMessage.fadeOut('slow', function() {
              var html = template('draftTextTemplate', {
                draftText : self.draftSavedText
              });
              self.$draftMessage.html(html).fadeIn('slow');
            });
          }
        });
      }, function(err) {
        postData.code = data.code;
        $.post(url, postData)
        .done(function(result) {
          if (result.success) {
            self._viewingDraft = true;
            self.$draftMessage.fadeOut('slow', function() {
              var html = template('draftTextTemplate', {
                draftText : self.draftSavedText
              });
              self.$draftMessage.html(html).fadeIn('slow');
            });
          }
        });
      });
    },
    discardDraft : function(done) {
      var self = this
        , url  = '/api/drafts/' + self._original.id;

      $.ajax({
          url    : url
        , method : 'DELETE'
      }).done(function(result) {
        if (result.success) {
          // reset trinket to saved version...
          if (JSON.stringify(self._trinket.settings) !== JSON.stringify(self._predraft.settings)) {
            self.discardDraftSettings();
            TrinketIO.runtime('settingsModified', false);

            // if draft loaded with page
            if (self._original_draft) {
              runtimeSettings(self._predraft.settings || {}, true);
            }
          }

          $('#confirmDiscardModal').foundation('reveal', 'close');

          self._original = $.extend(true, {}, self._predraft);
          $(document).trigger('trinket.draft.discard');
          $(self).trigger('trinket.draft.discard');

          // clear message
          self.$draftMessage.fadeOut('fast', function() {
            self.$draftMessage.empty();
            self._viewingDraft = false;
            $('.save-it').addClass('disabled');
          });
        }

        done();
      });
    },
    discardDraftSettings : function() {
      // stub that can be overridden per trinket type
    },
    _viewingOriginal : function(flag) {
      if (flag !== undefined) {
        this._viewingOriginalFlag = !!flag;
        flag
          ? $('body').addClass('viewing-original')
          : $('body').removeClass('viewing-original');
      }

      return this._viewingOriginalFlag;
    },
    autoSave : function() {
      var self = this
        , data = self.serialize()
        , url  = '/api/trinkets/' + self._original.id + '/autosave'
        , postData, zip;

      if (self.partnerAutoSave) {
        var t = window.location.pathname.split('/').slice(-1)[0];
        url = '/api/partner-trinkets/' + self._original.id + '/' + t + '/autosave';
      }

      self.$draftMessage.fadeOut('fast', function() {
        self.$draftMessage.text('Saving ...').fadeIn('slow', function() {
          postData = {
              assets   : data.assets
            , settings : data.settings
          };

          zip = new JSZip();
          zip.file("zipCode", JSON.stringify(data.code));

          zip.generateAsync({ type: "base64", compression: "DEFLATE", compressionOptions: { level: 9 } }).then(function(content) {
            postData.zipCode = content;
            $.post(url, postData).done(function(result) {
              if (result.success) {
                self.$draftMessage.fadeOut('slow', function() {
                  self.$draftMessage.text('Saved').fadeIn('slow');
                });
                $(self).trigger("trinket.code.autosave");
                if (self.assignment && window.parent) {
                  window.parent.postMessage("trinket.code.autosave", "*");
                }
              }
              else {
                self.$draftMessage.fadeOut('slow', function() {
                  self.$draftMessage.text('Error Saving').fadeIn('slow');
                });
              }
            });
          }, function(err) {
            postData.code = data.code;
            $.post(url, postData).done(function(result) {
              if (result.success) {
                self.$draftMessage.fadeOut('slow', function() {
                  self.$draftMessage.text('Saved').fadeIn('slow');
                });
                $(self).trigger("trinket.code.autosave");
                if (self.assignment && window.parent) {
                  window.parent.postMessage("trinket.code.autosave", "*");
                }
              }
              else {
                self.$draftMessage.fadeOut('slow', function() {
                  self.$draftMessage.text('Error Saving').fadeIn('slow');
                });
              }
            });
          });
        });
      });
    },
    onSaveClick : function() {
      var start = Date.now();
      $('body').addClass('saving');
      var done = function() {
        var elapsed = Date.now() - start;
        if (elapsed < 750) {
          return window.setTimeout(done, 750 - elapsed);
        }

        $('body').removeClass('saving');
      };

      if (this._original && this._original.id) {
        // revert the remix to the original code
        if (this._viewingOriginal()) {
          this.restore(done);
        }
        // update the remix
        else if (this._original.original) {
          this.save(undefined, done);
        }
        // create a remix
        else {
          this.remix(done);
        }
      }
      else {
        // for anonymous trinkets, just create a copy for the library
        this.addToLibrary(done);
      }
    },
    keys : function() {
      return this._keys || (this._keys = {
        code:1, assets:1, settings:1
      });
    },
    restore : function(onComplete) {
      var self = this,
          html = template('restoreOriginalModalTemplate', {}),
          $msg = $(html);
          remix = this._original,
          original = remix.original;

      $('body').append($msg);
      $msg.foundation('reveal', 'open');
      $msg.on('close.fndtn.reveal', function () {
        onComplete();
      });

      $msg.find('.button').click(function() {
        var action = $(this).data('action'),
            cloneable = {},
            key, original_code;

        if (action === 'confirm') {
          $msg.off('close.fndtn.reveal');
          for (key in self.keys()) {
            cloneable[key] = original[key];

            // remove comments
            // code is either a JSON array of file objects or a plain source
            // string (single-file trinkets); only the array form carries
            // per-file comments to strip. JSON.parse on a plain string throws,
            // which previously aborted the save/remix before it completed.
            if (key === "code") {
              try {
                original_code = JSON.parse(cloneable[key]);
              } catch (e) {
                original_code = null;
              }
              if (_.isArray(original_code)) {
                original_code = original_code.map(function(file) {
                  return _.omit(file, "comments");
                });
                cloneable[key] = JSON.stringify(original_code);
              }
            }
          }
          $.extend(true, remix, cloneable);
          $( "#version-toggle" ).prop("checked", true).change();
          window.setTimeout(function(){
            self.save(undefined, onComplete);
            self.updateSessionCache();
          });
        }
        else {
          onComplete();
        }

        $msg.foundation('reveal', 'close');
        $msg.remove();
      });
    },
    remix : function(onComplete) {
      var self = this;

      self._createCopy("Remix",
        function(trinket) {
          $('body').addClass('has-remix');
          trinket.original = self._original;
          self.setTrinket(trinket, true);
          self.reset(trinket);
          if(typeof onComplete === "function") {
            onComplete();
          }
        }
      );
    },
    addToLibrary : function(onComplete) {
      this._createCopy("Copy",
        function(trinket) {
          var html = template('statusMessageTemplate', {
            type:'success',
            message: 'A copy of this trinket has been saved for you. View or edit <a class="text-link" href="/library/trinkets/' + trinket.shortCode + '" target="_blank">your copy here</a>.'
          });
          var $msg = $(html);
          $('body').addClass('has-status-bar').append($msg);
          $msg.parent().foundation().trigger('open.fndtn.alert');

          if (onComplete && typeof onComplete === 'function') {
            onComplete(trinket);
          }
        }
      );
    },
    _createCopy : function(eventAction, onComplete) {
      var self       = this,
          data       = self.serialize({ removeComments : true }),
          options    = {library:true},
          originalId = self._original && self._original.id,
          done       = function(trinket) {
            self.$overlay.addClass('hide');

            if (onComplete && typeof onComplete === 'function') {
              onComplete(trinket);
            }

            $('.save-it').addClass('disabled');

            self.$draftMessage.fadeOut('slow', function() {
              self.$draftMessage.empty();
              self._viewingDraft = false;
            });

            self.callAnalytics('Interaction', eventAction, 'Library');
          };

      // clear any previous messages
      $('#statusMessages .close').click();
      self.$overlay.removeClass('hide');

      if (originalId) {
        data._origin_id = originalId;
      }

      if (eventAction == "Remix") {
        data._remix = true;
      }

      self._trinket.id
        ? self.fork(self._trinket, data, options, done)
        : self.create(data, options, done);
    },
    getTrinket : function(options, done) {
      var self = this;

      if (typeof(options) === 'function') {
        done    = options;
        options = undefined;
      }

      if (self.isModified() || !self._trinket.id) {
        return (self._trinket.id)
          ? self.fork(self._trinket, self.serialize(), options, done)
          : self.create(self.serialize(), options, done);
      }
      else {
        return setTimeout(function() {
          done(self._trinket);
        });
      }
    },
    setTrinket : function(trinket, asOriginal) {
      if (asOriginal) {
        this._original = trinket;
      }
      // preserve the original by creating a clone of the trinket
      this._trinket = $.extend(true, {}, trinket);
    },
    isModified : function() {
      var value = this.getValue();
      var modified = value !== (this._trinket.code || '') || this.settingsModified();
      return modified;
    },
    settingsModified : function() {
      return TrinketIO.runtime('settingsModified');
    },
    viewingDraft : function() {
      return this._viewingDraft;
    },
    getType : function() {
      throw new Error('getType is not implemented');
    },
    getValue : function() {
      throw new Error('getValue is not implemented');
    },
    getMainFile : function() {
      return '';
    },
    getShareType : function() {
      return $('#shareType').val() || this.getType();
    },
    getTimeoutDelay : function() {
      return this.serversideTimeoutDelay;
    },
    serialize : function(opts) {
      return {
        code : this.getValue(opts)
      }
    },
    fork : function(parent, data, options, done) {
      var self = this,
          url  = '/api/trinkets/' + parent.id + '/forks';

      if (typeof(options) === 'function') {
        done    = options;
        options = undefined;
      }

      if (options && options.library) {
        url += '?library=true';
      }

      $.post(url, data)
      .done(function(result) {
        self.setTrinket(result.data);
        $('#emailToken').val('');
        self.postSave().then(function() {
          if (typeof done === 'function') {
            done(self._trinket);
          }
        });
      });
    },
    create : function(data, options, done) {
      var self = this,
          url  = '/api/trinkets';

      if (typeof(options) === 'function') {
        done    = options;
        options = undefined;
      }

      if (options && options.library) {
        url += '?library=true';
      }

      data.lang = this.getType();

      $.post(url, data)
      .done(function(result) {
        self.setTrinket(result.data);
        $('#emailToken').val('');
        self.postSave().then(function() {
          if (typeof done === 'function') {
            done(self._trinket);
          }
        });
      });
    },
    save : function(data, done) {
      var self      = this,
          startTime = (new Date()).getTime();

      if (!data) data = this.serialize();

      self.$overlay.removeClass('hide');

      $.ajax({
          url         : '/api/trinkets/' + self._original.id + '/code'
        , data        : JSON.stringify(data)
        , type        : 'PUT'
        , contentType : 'application/json'
      })
      .done(function(result) {
        $('.save-it').addClass('disabled');
        self.$draftMessage.fadeOut('slow', function() {
          self.$draftMessage.empty();
          self._viewingDraft = false;
        });

        var elapsed = (new Date()).getTime() - startTime;
        for (var key in data) {
          self._trinket[key] = data[key];
        }

        // if this is a remix, be sure to keep a reference to the original
        if (self._original.original) {
          self._trinket.original = self._original.original;
        }

        self._original = self._predraft = self._trinket;

        setTimeout(function() {
          self.$overlay.addClass('hide');
        }, Math.max(0, 500 - elapsed));

        if (typeof done === 'function') {
          done();
        }

        self.postSave();
      })
      .fail(function(xhr, textStatus, errorThrown) {
        if (typeof done === 'function') {
          done({
            responseText : xhr.responseText,
            status       : textStatus,
            error        : errorThrown
          });
        }
      });
    },
    onResetClick : function(event) {
      var self = this;

      this.$resetModal.foundation('reveal', 'close');

      var resetTrinket = function() {
        self.setTrinket(self._original);
        self.reset(self._trinket);

        $(document).trigger('trinket.resetted');
      }

      if (this.viewingDraft()) {
        this.discardDraft(resetTrinket);
      }
      else {
        resetTrinket();
      }

      try {
        window.sessionStorage && window.sessionStorage.removeItem(this.guid);
        storage.remove(this.guid);
      } catch(e) {}

      if (window.parent) {
        window.parent.postMessage("reset", "*");
      }

      this.callAnalytics('Interaction', 'Click', 'Reset');

      if ($('.file-name-error').length) {
        $('.file-name-error').find('.close').trigger('click');
      }
    },
    reset : function(trinket) {
    },
    clickReset : function() {
      $(document).trigger('trinket.code.reset');
    },
    focus : function() {
      // stub - each trinket type should implement if needed
    },
    goToStart : function() {
      // stub - each trinket type should implement if needed
    },
    onUpdateClick : function() {
      this.save(this.serialize());
    },
    onShareClick : function(event) {
      var self = this,
          shareParams = [],
          paramStr    = '';

      if (event.isDefaultPrevented()) {
        return;
      }

      self.getTrinket(function(trinket) {
        var share = self.getShareInfo(trinket),
            url   = qualifyUrl(share.url);

        $('#runOptionLink').data('trinket-shortCode', trinket.shortCode);
        $('#runOptionLink').data('trinket-runMode',   self.runMode);

        $('#displayOptionLink').data('trinket-shortCode', trinket.shortCode);
        $('#displayOptionLink').data('trinket-runMode',   self.runMode);

        if ($('#displayOptionLink').val()) {
          shareParams.push($('#displayOptionLink').val() + '=true');
        }

        if ($('#runOptionLink').val()) {
          shareParams.push('runOption=' + $('#runOptionLink').val());
        }

        // if in console mode
        if (self.runMode) {
          shareParams.push('runMode=' + self.runMode);
        }

        if (shareParams.length) {
          paramStr = '?' + shareParams.join('&');
        }

        url = url.replace(trinket.shortCode, trinket.shortCode + paramStr);

        self.$shareUrl.text(url);
        self.$shareModal.foundation('reveal', 'open');

        self.sendAnalytics('Navigation', {
          action    : 'View Modal',
          label     : 'share'
        }, {
          name      : 'Snippet Modal Viewed',
          modalType : 'share'
        });
      });
    },
    onEmailClick : function(event) {
      var self = this;
      if (event.isDefaultPrevented()) {
        return;
      }

      self.getTrinket(function(trinket) {
        var share = self.getShareInfo(trinket),
            url   = qualifyUrl(share.url);

        self.$shareUrl.text(url);
        self.$emailModal.foundation('reveal', 'open');

        self.sendAnalytics('Navigation', {
          action    : 'View Modal',
          label     : 'email'
        }, {
          name      : 'Snippet Modal Viewed',
          modalType : 'email'
        });
      });
    },
    getShareInfo : function(trinket) {
      return {
        url : '/' + this.getShareType() + '/' + this.getTrinketIdentifier(trinket)
      }
    },
    onShareFocus : function(event) {
      selectText.byId("shareUrl");
      this.updateMetric('linkShares');
      this.sendAnalytics('Shares', {
        action    : 'Focus',
        label     : 'link'
      }, {
        name      : 'Snippet Shared',
        shareType : 'link'
      });
    },
    onEmbedClick : function(event) {
      var self = this,
          shareParams = [],
          paramStr    = '';

      if (event.isDefaultPrevented()) {
        return;
      }

      self.getTrinket(function(trinket) {
        var embed = self.getEmbedInfo(trinket),
            url   = qualifyUrl(embed.url),
            code  = '<iframe src="' + url + '" width="100%" height="' + (embed.height || 356) + '" frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>';

        $('#runOptionEmbed').data('trinket-shortCode', trinket.shortCode);
        $('#runOptionEmbed').data('trinket-runMode',   self.runMode);

        $('#displayOptionEmbed').data('trinket-shortCode', trinket.shortCode);
        $('#displayOptionEmbed').data('trinket-runMode',   self.runMode);

        if ($('#displayOptionEmbed').val()) {
          shareParams.push($('#displayOptionEmbed').val() + '=true');
        }

        if ($('#runOptionEmbed').val()) {
          shareParams.push('runOption=' + $('#runOptionEmbed').val());
        }

        if ($('#autorunEmbedToggle').is(':checked')) {
          shareParams.push('start=result');
        }

        // if in console mode
        if (self.runMode) {
          shareParams.push('runMode=' + self.runMode);
        }

        if (shareParams.length) {
          paramStr = '?' + shareParams.join('&');
        }

        code = code.replace(trinket.shortCode, trinket.shortCode + paramStr);

        self.$embedCode.text(code);
        self.$embedModal.foundation('reveal', 'open');

        self.sendAnalytics('Navigation', {
          action    : 'View Modal',
          label     : 'embed'
        }, {
          name      : 'Snippet Modal Viewed',
          modalType : 'embed'
        });
      });
    },
    getEmbedInfo : function(trinket) {
      var path = '/' + this.getTrinketIdentifier(trinket);

      return {
        url    : '/embed/' + this.getType() + path,
        height : 356
      };
    },
    onEmbedFocus : function(event) {
      selectText.byId("embedCode");
      this.updateMetric('embedShares');
      this.sendAnalytics('Shares', {
        action    : 'Focus',
        label     : 'embed'
      }, {
        name      : 'Snippet Shared',
        shareType : 'embed'
      });
    },
    updateMetric : function(metric, codeKey) {
      var self      = this,
          noMetrics = $('body').data('no-metrics');

      if (!metric || noMetrics || !this._trinket || !this._trinket.id) {
        return;
      }

      if (codeKey) {
        var hash = CryptoJS.MD5(codeKey);
        codeKey  = hash.toString(CryptoJS.enc.Hex);
      } else {
        codeKey = this._trinket.id;
      }

      if (!this._updates[metric]) {
        this._updates[metric] = {};
      }

      if (this._updates[metric][codeKey]) {
        return;
      }

      this._updates[metric][codeKey] = true;

      var data = {};
      data[metric] = true;
      $.ajax({
          url      : '/api/trinkets/' + this._trinket.id + '/metrics'
        , type     : 'PUT'
        , dataType : 'json'
        , data     : data
      });
    },
    onLogoClick : function(event) {
      var self = this;

      event.preventDefault();
      self.getTrinket(function(trinket) {
        var share = self.getShareInfo(trinket);
        self.sendAnalytics('Navigation', {
          action    : 'Click',
          label     : 'Logo'
        }, {
          name      : 'Snippet Logo Clicked'
        });
        window.open(qualifyUrl(share.url));
      });
    },
    onGalleryClick : function(event) {
      event.preventDefault();
      window.open(qualifyUrl('/gallery'));
    },
    onNotificationClick : function(event) {
      event.preventDefault();
      var self = this;
      if (this._notification_open) {
        $('#notification-content').animate({
          'margin-top': '-100%'
        }, 400, function() {
          self._notification_open = false;
        });
      } else {
        $('#notification-content').animate({
          'margin-top': 0
        }, 400, function() {
          self._notification_open = true;
          self.sendAnalytics('Navigation', {
            action    : 'Click',
            label     : 'Notification'
          }, {
            name      : 'Snippet Notification Clicked'
          });
        });
      }
    },
    onSendEmailClick : function(recaptcha) {
      var self = this;

      if ($('#share-email').val() && $('#share-yourname').val() && $('#share-youremail').val()){
        $('.close').click();
        $('#sendEmail').attr('value', 'Sending ...');
        $('#sendEmail').addClass('disabled');

        $.post('/api/trinkets/' + self._trinket.id + '/email', {
          email   : $('#share-email').val(),
          name    : $('#share-yourname').val(),
          replyTo : $('#share-youremail').val(),
          token   : $('#emailToken').val(),
          'g-recaptcha-response' : recaptcha
        }).done(function(data) {
          self.$emailModal.foundation('reveal', 'close');

          var alertBox = '<div data-alert class="alert-box success"> Your email was sent! Thanks for sharing! <a href="#" class="close">&times;</a></div>';
          $('#flashMessage').show();
          $('#flashContent').html(alertBox);
          $(document).foundation('alert', 'reflow');

          $('#share-email').val('');
          setTimeout(function() {
            $('#flashMessage .close').trigger('click');
          }, 3000);

          self.sendAnalytics('Shares', {
            action    : 'Send Email'
          }, {
            name      : 'Snippet Email Sent'
          });
        }).fail(function(jqXHR, textStatus, errorThrown) {
          self.$emailModal.foundation('reveal', 'close');

          var alertBox = '<div data-alert class="alert-box warning"> There was a problem sending your email. Please try again later. <a href="#" class="close">&times;</a></div>';
          $('#flashMessage').show();
          $('#flashContent').html(alertBox);
          $(document).foundation('alert', 'reflow');
        }).always(function() {
          $('#sendEmail').attr('value', 'Send');
          $('#sendEmail').removeClass('disabled');
        });
      } else {
        var alertBox = '<div data-alert class="alert-box warning"> Please complete all fields to send your email. <a href="#" class="close">&times;</a></div>';
        $('#emailAlert').show().html(alertBox);
        $(document).foundation('alert');
      }
    },
    getAnalyticsCategory : function() {
      return 'Snippet';
    },
    sendInterfaceAnalytics : function(el, options) {
      options || (options = {});

      var $el = $(el)
        , interfaceAction = $el.data('action') || options.action
        , interfaceData   = $el.data('data') || options.data
        , interfaceName   = $el.closest('[data-interface]').data('interface') || options.interface
        , libraryOverride = $el.data('library-override') || false
        , interfaceSize   = this.$responsiveIndicators.filter(function(index) {
            return $(this).css('display') !== 'none';
          }).data('size') || ''
        , action = [
            interfaceSize
            , interfaceName
            , interfaceAction.replace(/\./g, '-')
          ];

      if (interfaceData) {
        action.push(interfaceData);
      }

      action = action.join(' ').replace(
        /[a-zA-Z0-9](?:[^\s\-\._]*)/g
        , function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1);}
      );

      this.sendAnalytics('Interface', {
        action  : action
        , label : this.getTrinketIdentifier()
      }, libraryOverride);
    },
    sendAnalytics : function(category, gaOptions, libraryOverride) {
      var self      = this,
          embed     = self.getEmbedInfo(self._trinket),
          inLibrary = self._queryString && self._queryString.inLibrary;

      gaOptions = $.extend({
        category : self.getAnalyticsCategory() + ' ' + category
      }, gaOptions)

      // most analytics shouldn't be sent from library
      // add data-library-override="true" to override

      if (window.gtag && !self._queryString.snapshot && (!inLibrary || (inLibrary && libraryOverride)) ) {
        var event_parameters = {
          'event_action': gaOptions.action,
          'event_category': gaOptions.category,
          'trinket_type': this.getType()
        };

        if (self._trinket && self._trinket.shortCode) {
          event_parameters['trinket_shortCode'] = self._trinket.shortCode;
        }

        if (typeof libraryOverride === 'object') {
          for (var prop in libraryOverride) {
            event_parameters[prop] = libraryOverride[prop];
          }
          libraryOverride = false;
        }

        if (gaOptions.label) {
          event_parameters['label'] = gaOptions.label;
        }
        if (gaOptions.value) {
          event_parameters['value'] = gaOptions.value;
        }

        window.gtag('event', 'embedded_trinket', event_parameters);
      }
    },
    /**
     * simple wrapper for sendAnalytics - most calls can use this simpler version
     */
    callAnalytics : function(category, action, label) {
      this.sendAnalytics(category, {
          action : action
        , label  : label
      });
    },
    logClientMetric : function(data) {
      if (trinket.config.logClientMetric) {
        // make sure some error here doesn't affect trinket
        try {
          data.lang = this.getType();

          if (this._trinket && this._trinket.id) {
            data.trinketId = this._trinket.id;
          }

          $.post('/api/trinkets/clientmetric', data).done(function() {});
        } catch(e) {}
      }
    },
    toggleOverlay : function(overlay) {
      $(overlay).toggleClass('hide');

      if ($(overlay).hasClass('hide')) {
        this.hasOverlay = false;
        this.onCloseOverlay();
      }
      else {
        this.hasOverlay = true;
        this.onOpenOverlay();
      }
    },
    closeOverlay : function(overlay) {
      $(overlay).addClass('hide');
      this.hasOverlay = false;
    },
    closeAnyModal : function() {
      if ($('.close-reveal-modal').is(':visible')) {
        $('.close-reveal-modal').click();
      }
    },
    closeAnyMessage : function() {
      if ($('.close').is(':visible')) {
        $('.close').click();
      }
    },
    draggable : function(resizeFn) {
      var dragbar_width = $('#dragbar').width();
      var $editor = $('#editor');
      var self = this;

      $(document).on('mousedown.dragbar', '#dragbar', function(e) {
        e.preventDefault();

        var wrapper_width = $('.trinket-content-wrapper').width();

        $('#content-overlay').show();
        self.dragging = true;
        var $ghostbar = $('<div>', {
          id  : 'ghostbar',
          css : {
            height : $editor.outerHeight(),
            top    : $editor.offset().top,
            left   : $editor.offset().left
          }
        }).appendTo('body');

        $(document).on('mousemove.dragbar', function(event) {
          var leftPct = event.pageX / wrapper_width;
          var rightPct = ( wrapper_width - event.pageX ) / wrapper_width;
          if (leftPct >= .3 && rightPct >= .25) {
            $ghostbar.css('left', event.pageX + 2);
            $('#editor').css('width', event.pageX + 2);

            if (resizeFn) {
              resizeFn();
            }
          }
        });

        $(document).one('mouseup.dragbar', function(e) {
          $('#content-overlay').hide();

          if (self.dragging) {
            $('#ghostbar').remove();
            $(document).off('mousemove.dragbar');
            self.dragging = false;
          }
        });
      });
    },
    // stubs
    toggleAll : function() {
    },
    onOpenOverlay : function() {
    },
    onCloseOverlay : function() {
    },
    postSave : function() {
      var deferred  = $.Deferred()
        , self      = this
        , shortCode = self._trinket.shortCode;

      function done() {
        return deferred.resolve();
      }

      if (self.saveClientSnapshot()) {
        self.captureAndSaveSnapshot(function(png) {
          if (png) {
            $.post('/api/trinkets/' + shortCode + '/snapshot', {
              snapshotData : png
            }).done(done);
          }
          else {
            return done();
          }
        });

        return deferred;
      }

      return done();
    },
    saveClientSnapshot : function() {
      return false;
    },
    isDirty : function() {
      if (!this._trinket) return false;
      return !(this.getValue() === this._original.code);
    },
    destroy : function() {
      this._trinket = undefined;
    },
    getTrinketIdentifier : function(trinket) {
      trinket || (trinket = this._trinket);

      return trinket.shortCode
        ? trinket.shortCode
        : CryptoJS.MD5(trinket.code).toString(CryptoJS.enc.Hex);
    },
    getTrinketIdentifierOrNull : function() {
      var id = null;

      if (this._trinket) {
        id = this._trinket.original ? this._trinket.original.shortCode : this._trinket.shortCode;
      }

      return id;
    },
    metadata : function() {
      var data = {}
        , shortCode = this.getTrinketIdentifierOrNull();

      if (shortCode) {
        data.shortCode = shortCode;
      }

      if (this._userId) {
        data.userId = this._userId;
        data.userPlan = this.hasRole("trinket-connect")
          ? "connect"
          : this.hasRole("trinket-codeplus")
            ? "codeplus"
            : "code";
      }

      if (this._trinket && this._trinket._owner) {
        data.ownerId = this._trinket._owner;
      }

      data.lang = this.getType();

      if (document.referrer) {
        data.referer = document.referrer;
      }

      // tbd: add code/assets if anonymous and/or no shortCode?
      // can't add code and assets because they're likely too large for a query string

      return data;
    },
    logError : function(data) {
      if (trinket.config.logClientCodeError) {
        data.lang = this.getType();

        if (this._trinket && this._trinket.shortCode) {
          data.shortCode = this._trinket.shortCode;
        }

        $.post('/api/trinkets/codeerror', data).done(function() {});
      }
    },
    triggerRunModeChange : function() {
      $(document).trigger('trinket.runMode.change', { "runMode" : this.runMode });
      this.trigger('trinket.runMode.change', { "runMode" : this.runMode });
    },
    settingsChange : function(event) {
      var settingsValue
        , settingsType = $(event.target)[0].type;

      this._trinket.settings = $.extend(true, {}, this._trinket.settings);

      // @TODO as we add other settings,
      // we'll need to update this to capture them based on input type
      if (settingsType === "checkbox") {
        settingsValue = $(event.target).is(":checked");
      }
      else if (settingsType === "range" || settingsType === "hidden") {
        settingsValue = $(event.target).val();
      }

      if (typeof settingsValue !== "undefined") {
        this._trinket.settings[event.target.id] = settingsValue;
        TrinketIO.runtime('settingsModified', true);
      }

      if ($(event.target).data('settings-action') && typeof this[ $(event.target).data('settings-action') ] === 'function') {
        this[ $(event.target).data('settings-action') ]();
      }

      // prevent synthetic events from saving a draft - they'll have data-skip-trigger set
      // they're likely being used to reset settings after a discarded draft
      if ($(event.target).data('skip-trigger')) {
        $(event.target).removeData('skip-trigger');
      }
      else {
        this.triggerChange();
      }
    },
    lineWrappingChange : function(event) {
      this.setWrap($(event.target).is(':checked'));
    },
    indentChange : function(event) {
      this.setIndent($(event.target).val());
    },
    showOutput : function() {
      $('#codeOutput').removeClass('hide');
      $('#editor').addClass('hide');

      this.closeOverlay('#modules');

      $('#instructionsContainer').addClass('hide');
      $('#outputContainer').removeClass('hide');

      $('#codeOutputTab').addClass('active');
      $('#instructionsTab').removeClass('active');
    },
    showInstructions : function() {
      $('#codeOutput').removeClass('hide');
      $('#editor').addClass('hide');

      this.closeOverlay('#modules');

      if (!this.parsedInstructions) {
        this.displayInstructions();
      }

      $('#outputContainer').addClass('hide');
      $('#blocklyCodeContainer').addClass('hide');
      $('#instructionsContainer').removeClass('hide');

      $('#codeViewTab').removeClass('active');
      $('#codeOutputTab').removeClass('active');
      $('#instructionsTab').addClass('active');
    },
    displayInstructions : function() {
      if (typeof parser === 'undefined') return;

      var self = this;

      if (!self._trinket.description && self.getUIType() === 'owner') {
        self.parsedInstructions = template('addInstructionsTemplate');
      }
      else {
        self.parsedInstructions = parser(self._trinket.description);
      }

      $('#instructionsOutput').html(self.parsedInstructions);

      if ($('#instructionsActions').length) {
        $('#instructionsActions').removeClass('hide');
      }
    },
    onEditInstructionsClick : function() {
      var self = this;

      $('#instructionsActions').addClass('hide');
      $('#instructionsToolbar').removeClass('hide');
      $('#instructionsContainer').addClass('editor');

      self.parsedInstructions = template('editInstructionsTemplate');

      $('#instructionsOutput').empty();
      $('#instructionsContainer').append(self.parsedInstructions);

      var wrapperHeight = $('#instructionsContainer').height();

      instructionsEditor = ace.edit("embedded-instructions");

      var aceHeight = wrapperHeight - 65;
      $('#embedded-instructions').height(aceHeight + 'px');
      instructionsEditor.resize();

      instructionsEditor.$blockScrolling = Infinity;
      instructionsEditor.setTheme("ace/theme/xcode");
      instructionsEditor.getSession().setMode("ace/mode/markdown");
      instructionsEditor.getSession().setUseSoftTabs(true);
      instructionsEditor.getSession().setTabSize(2);
      instructionsEditor.setShowPrintMargin(false);

      if (self._trinket.description !== null && self._trinket.description.length) {
        instructionsEditor.getSession().setValue(self._trinket.description, -1);
      }
    },
    onCancelEditInstructionsClick : function() {
      var self = this;

      $('#instructionsContainer').removeClass('editor');
      $('#instructionsToolbar').addClass('hide');
      $('#instructionsActions').removeClass('hide');

      if (instructionsEditor) {
        instructionsEditor.destroy();
      }
      $('#embedded-instructions').remove();

      self.displayInstructions();
    },
    onSaveInstructionsClick : function(event) {
      var self = this
        , description = instructionsEditor.getValue();

      $('#save-instructions').find('i').removeClass().addClass('fa fa-circle-o-notch fa-spin');

      $.ajax({
          url         : '/api/trinkets/' + self._original.id + '/description'
        , data        : JSON.stringify({ description : description })
        , type        : 'PUT'
        , contentType : 'application/json'
      })
      .done(function(result) {
        setTimeout(function() {
          $('#save-instructions').find('i').removeClass().addClass('fa fa-save');
          self._trinket.description = description;

          // Close dialog
          $('#instructionsContainer').removeClass('editor');
          $('#instructionsToolbar').addClass('hide');
          $('#instructionsActions').removeClass('hide');

          if (instructionsEditor) {
            instructionsEditor.destroy();
          }
          $('#embedded-instructions').remove();

          self.displayInstructions();
        }, 500);
      })
      .fail(function(xhr, textStatus, errorThrown) {
      });
    },
    setKey : function(key, val) {
      this._varProxy[key] = val;
    },
    getKey : function(key) {
      return this._varProxy[key];
    },
    onKeyboardToggle : function() {
    }
  }, window.TrinketAPI);

  window.TrinketApp = new TrinketApp(window.trinketObject, window.draftObject);
  if (window.parent) {
    if (window.TrinketApp._queryString && (window.TrinketApp._queryString.inLibrary || window.TrinketApp._queryString.listen)) {
      window.parent.postMessage("TrinketApp ready", qualifyUrl(""));
    }
    else if (window.TrinketApp.assignment) {
      // TODO! add subdomain target
      window.parent.postMessage("TrinketApp ready", "*");
      var initialState = window.TrinketApp.serialize();
      initialState._initial = true;
      window.parent.postMessage(initialState, "*");
    }
  }
});
