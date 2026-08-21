// Serial SREV-style speech queue. Each group is played with speak-and-wait
// semantics, so bulletin types never overlap.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SrevAnnouncer = factory();
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function splitText(value, maxLength) {
    var text = cleanText(value);
    var limit = Math.max(1, Number(maxLength) || 128);
    if (!text) return [];
    var chunks = [];
    while (text.length > limit) {
      var end = limit;
      var floor = Math.floor(limit * 0.55);
      for (var i = limit; i >= floor; i--) {
        if ('。！？、'.indexOf(text.charAt(i - 1)) >= 0) { end = i; break; }
      }
      chunks.push(text.slice(0, end));
      text = text.slice(end).trim();
    }
    if (text) chunks.push(text);
    return chunks;
  }

  function intensityRank(value) {
    var ranks = {'0':0,'1':1,'2':2,'3':3,'4':4,'5-':5,'5+':5.5,'6-':6,'6+':6.5,'7':7};
    var key = String(value == null ? 0 : value);
    return Object.prototype.hasOwnProperty.call(ranks, key) ? ranks[key] : (Number(value) || 0);
  }

  function freezeIntensitySnapshot(previous, current, ids) {
    previous = previous || {};
    current = current || {};
    ids = Array.isArray(ids) ? ids : Object.keys(Object.assign({}, previous, current));
    var snapshot = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var prior = previous[id] || 0;
      var now = current[id] || 0;
      snapshot[id] = intensityRank(now) > intensityRank(prior) ? now : prior;
    }
    return Object.freeze(snapshot);
  }

  function create(options) {
    options = options || {};
    if (typeof options.speak !== 'function') throw new TypeError('SrevAnnouncer requires speak(text, onEnd, onError)');
    var maxLength = Math.max(1, Number(options.maxLength) || 128);
    var maxGroups = Math.max(1, Number(options.maxGroups) || 8);
    var groups = [];
    var activeGroup = null;
    var activeController = null;
    var generation = 0;

    function settle(group, error) {
      if (group.cancelled) return;
      activeController = null;
      activeGroup = null;
      if (error) {
        if (typeof group.onError === 'function') group.onError(error);
      } else if (typeof group.onComplete === 'function') {
        group.onComplete();
      }
      pump();
    }

    function playNextChunk(group, token) {
      if (token !== generation || activeGroup !== group) return;
      if (group.index >= group.chunks.length) { settle(group, null); return; }
      var text = group.chunks[group.index++];
      var completed = false;
      function done() {
        if (completed || token !== generation || group.cancelled) return;
        completed = true;
        activeController = null;
        playNextChunk(group, token);
      }
      function failed(error) {
        if (completed || token !== generation || group.cancelled) return;
        completed = true;
        settle(group, error || new Error('SREV speech failed'));
      }
      try {
        var controller = options.speak(text, done, failed) || null;
        if (!completed && token === generation && activeGroup === group) activeController = controller;
      } catch (error) {
        failed(error);
      }
    }

    function pump() {
      if (activeGroup || !groups.length) return;
      activeGroup = groups.shift();
      playNextChunk(activeGroup, generation);
    }

    function cancelGroup(group) {
      if (!group || group.cancelled) return;
      group.cancelled = true;
      if (typeof group.onCancel === 'function') group.onCancel();
    }

    function cancelMatching(matcher, includeActive) {
      var match = typeof matcher === 'function'
        ? matcher
        : function(group) { return group.id === String(matcher || ''); };
      var retained = [];
      for (var i = 0; i < groups.length; i++) {
        if (match(groups[i])) cancelGroup(groups[i]);
        else retained.push(groups[i]);
      }
      groups = retained;
      if (includeActive && activeGroup && match(activeGroup)) {
        var group = activeGroup;
        var controller = activeController;
        activeGroup = null;
        activeController = null;
        cancelGroup(group);
        if (controller && typeof controller.abort === 'function') controller.abort();
      }
      pump();
    }

    return {
      enqueue: function(messages, hooks) {
        hooks = hooks || {};
        var values = Array.isArray(messages) ? messages : [messages];
        var chunks = [];
        for (var i = 0; i < values.length; i++) chunks = chunks.concat(splitText(values[i], maxLength));
        if (!chunks.length) {
          if (typeof hooks.onComplete === 'function') hooks.onComplete();
          return null;
        }
        var id = hooks.id || '';
        if (id && hooks.replace) cancelMatching(id, !!hooks.replaceActive);
        while (groups.length >= maxGroups) {
          var lowest = 0;
          for (var gi = 1; gi < groups.length; gi++) {
            if (groups[gi].priority < groups[lowest].priority) lowest = gi;
          }
          cancelGroup(groups.splice(lowest, 1)[0]);
        }
        var group = {
          id:id,chunks:chunks,index:0,priority:Number(hooks.priority) || 0,
          onComplete:hooks.onComplete,onError:hooks.onError,onCancel:hooks.onCancel,
          cancelled:false
        };
        group.abort = function() { cancelMatching(function(candidate) { return candidate === group; }, true); };
        var insertAt = groups.length;
        for (var pi = 0; pi < groups.length; pi++) {
          if (group.priority > groups[pi].priority) { insertAt = pi; break; }
        }
        groups.splice(insertAt, 0, group);
        pump();
        return group;
      },
      cancelMatching: cancelMatching,
      cancelAll: function() {
        generation++;
        for (var i = 0; i < groups.length; i++) cancelGroup(groups[i]);
        groups = [];
        var controller = activeController;
        cancelGroup(activeGroup);
        activeController = null;
        activeGroup = null;
        if (controller && typeof controller.abort === 'function') controller.abort();
      },
      pendingCount: function() { return groups.length + (activeGroup ? 1 : 0); },
      isSpeaking: function() { return !!activeGroup; }
    };
  }

  return { create:create, splitText:splitText, intensityRank:intensityRank, freezeIntensitySnapshot:freezeIntensitySnapshot };
}));
