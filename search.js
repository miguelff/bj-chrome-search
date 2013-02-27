/*
 * BeBanjo Omnibox Chrome extension
 *
 * @author Miguel Fernández <miguel@bebanjo.com>
 *
 * @license licensed under WTFPL (see License)
 * @usage type b in Chrome's address bar
 */

var Globals = {

  organizationURL: "https://github.com/bebanjo/",

  /**
   * There's a cached copy of the repository list
   * at bebanjo that expires after 5 minutes
   */
  storageExpiration: 5 * 60 * 1000, //5 minutes

  /*
   * in case there's no internet to retrieve the repository list,
   * and the local storage is empty, we will infer commands using
   * this set of respositories
   */
  fallbackRepositoryList: ["movida","sequence","sheriff","support","tron"],

  /**
   * This is the set of commands that can be
   */
  commands: {
    "p": {
      description: "pull requests",
      url: function(params) {
        return Globals.organizationURL + params[0] + "/pulls";
      }
    },

    "i": {
      description: "issues",
      url: function(params) {
        return Globals.organizationURL + params[0] + "/issues";
      }
    },

    "w": {
      description: "wiki",
      url: function(params) {
        return Globals.organizationURL + params[0] + "/wiki/_pages";
      }
    },

    "\\d+": {
      description: "issue detail",
      url: function(params) {
        return Globals.organizationURL + params[0] + "/issues/" + (params[1] || 123);
      }
    }
  }
}

var Util = {

  properties: function(object) {
    var props = [];
    for (var p in object) {
      props.push(p);
    }
    return props;
  },

  Browser: {
    openTab: function(url) {
      chrome.tabs.getSelected(null, function(tab) {
        chrome.tabs.update(tab.id, {url: url});
      });
    }
  },

  Text: {

    /**
     * Longest common substring
     * @returns {number} the size of the longest common substring of s1 and s2
     */
    lcs: function(s1, s2) {
      var lcs = 0;

      var table = Array(s1.length);
      for (a = 0; a <= s1.length; a++) {
        table[a] = Array(s2.length);
        for (b = 0; b <= s2.length; b++) {
          table[a][b] = 0;
        }
      }

      for (var i = 0; i < s1.length; i++) {
        for (var j = 0; j < s2.length; j++) {
          if (s1[i] == s2[j]) {
            if (table[i][j] == 0) {
              table[i + 1][j + 1] = 1;
            } else {
              table[i + 1][j + 1] = table[i][j] + 1;
            }
            if (table[i + 1][j + 1] > lcs) {
              lcs = table[i + 1][j + 1];
            }
          } else {
            table[i + 1][j + 1] = 0;
          }
        }
      }
      return lcs;
    }
  }
}


var RepositoryStore = function() {

  var scrapeProjects = function(data) {
    var repositories = [];
    $("h3 a", data).each(function(_, el) {
      repositories.push(el.text);
    });
    return repositories;
  }

  var loadRepositories = function(callback) {
    var storage = chrome.storage.local;
    storage.get({repositories: '', lastUpdated:''}, function(items) {
      if (!items.repositories || (Date.now() - items.lastUpdated > Globals.storageExpiration)) {
        // staled items
        $.ajax({
          url: Globals.organizationURL,
          dataType: "html",
          success: function(data) {
            items = {}
            items.repositories = scrapeProjects(data);
            items.lastUpdated = Date.now();
            storage.set(items);
            callback(items.repositories);
          },
          error: function(){
            if (items.repositories){
              storage.set({repositories: items.repositories, lastUpdated: Date.now()});
              callback(items.repositories);
            }else {
              callback(Globals.fallbackRepositoryList);
            }
          }
        });
      } else {
        callback(items.repositories);
      }
    });
  };

  return {
    /**
     * Finds the most relevants repositories in the organization
     * for the text given, and passes them to the given command
     *
     * Relevance criteria is determined by:
     *  - Most similar respository name (using longest common substring (LCS) algorithm)
     *  - repository name length (at equal LCS, shortest results will come first)
     *
     *  ex. for the text "mov", "movid" will come before "movida-account-setup-scripts"
     *
     *
     * @param text the text against which match the relevant repositories
     * @param limit {number} indicates to limit the result to the n most relevant results
     * @param callback function(Array) which will be called with the most relevant results.
     * The array contains strings, each of which is a repository name.
     */
    findRelevant: function(text, limit, callback) {
      return loadRepositories(function(repositories) {
        var bySimilarityShortestFirst = function(x, y) {
          var similarity = Util.Text.lcs(text, y) - Util.Text.lcs(text, x);
          return similarity == 0 ? x.length - y.length : similarity;
        }
        repositories = repositories.sort(bySimilarityShortestFirst).slice(0, limit);
        callback(repositories);
      })
    }
  };
}();

/**
 * Implements a state machine for suggesting and browsing results
 *
 * Each state is determined by the text typed, and should respond to:
 *  - infer(callback)
 *  - enter
 *
 */
var Suggestions = function() {

  /**
   * User is writing the repository name (ex. "mov")
   */
  var WritingRepositoryName = function(text) {

    return {
      inferSuggestions: function(callback) {
        var limit = 5;
        RepositoryStore.findRelevant(text, limit, function(repositories) {
          var suggestions = [];
          for (var i = 0; i < limit; i++) {
            suggestions.push({content: Globals.organizationURL + repositories[i], description: repositories[i]});
          }
          callback(suggestions);
          chrome.omnibox.setDefaultSuggestion({
            description: "Type <match>#</match> to show commands for <match>" + repositories[0] + "</match>, or <match>&#9166;</match> to visit <match>" + Globals.organizationURL + repositories[0] + "</match>"
          });
        });
      },

      enter: function() {
        RepositoryStore.findRelevant(text, 1, function(repositories) {
          Util.Browser.openTab(Globals.organizationURL + repositories[0]);
        });
      }
    };
  };

  /**
   * User has typed the repository name and entered a hash (#) to start typing command options  (ex. movida#)
   */
  var RepositoryNameWritten = function(text) {
    return {
      inferSuggestions: function(callback) {
        RepositoryStore.findRelevant(text, 1, function(repositories) {
          var suggestions = [];
          var defaultSuggestionTooltips = [];
          var repository = repositories[0];
          for (var command in Globals.commands) {
            defaultSuggestionTooltips.push("<match>" + command + "</match> (" + Globals.commands[command].description + ")");
            suggestions.push({content: Globals.commands[command].url([repository]), description: repository + "#" + command});
          }
          callback(suggestions);
          chrome.omnibox.setDefaultSuggestion({
            description: "Type one of [" + defaultSuggestionTooltips.join(" | ") + "]"
          });
        })
      },

      enter: function() {
        RepositoryStore.findRelevant(text, 1, function(repositories) {
          Util.Browser.openTab(Globals.organizationURL + repositories[0]);
        });
      }
    };
  };

  /**
   * User has typed a command (ex movida#i)
   */
  var CommandTyped = function(text) {

    var getUrl = function(text, callback) {
      var chunks = text.split("#");
      var repositoryName = chunks[0];
      var typedCommand = chunks[1];

      RepositoryStore.findRelevant(repositoryName, 1, function(repositories) {
        var repository = repositories[0];
        for (var command in Globals.commands) {
          if (new RegExp(command, "i").test(typedCommand)) {
            callback(Globals.commands[command].url([repository, typedCommand]));
          }
        }
      });
    };

    return {
      inferSuggestions: function(callback) {
        getUrl(text, function(url) {
          chrome.omnibox.setDefaultSuggestion({
            description: url
          });
        });
      },

      enter: function() {
        getUrl(text, function(url) {
          Util.Browser.openTab(url);
        });
      }
    };
  };

  /**
   * User has typed a text that will not drive to any known command (ex. mo!)
   */
  var Error = function(text) {
    return {
      inferSuggestions: function(callback) {
        chrome.omnibox.setDefaultSuggestion({
          description: "No match, try typing the first letters of a repository (ex. <match>mov</match>)"
        });
      },
      enter: function() {
      }
    }
  }

  /**
   * Returns the state given the typed text
   */
  var getState = function(text) {
    var currentState;

    if (/^[a-z0-9_-]+$/.test(text))
      currentState = WritingRepositoryName(text);
    else if (/^[a-z0-9_-]+#$/.test(text))
      currentState = RepositoryNameWritten(text.trim());
    else if (RegExp("^[a-z0-9_-]+#(" + Util.properties(Globals.commands).join("|") + ")$", "i").test(text))
      currentState = CommandTyped(text);
    else currentState = Error(text);

    return currentState;
  };

  var infer = function(text, callback) {
    getState(text).inferSuggestions(callback);
  };

  var enter = function(text) {
    getState(text).enter();
  };

  return {
    infer: infer,
    enter: enter
  };
}();

chrome.omnibox.onInputChanged.addListener(Suggestions.infer);
chrome.omnibox.onInputEntered.addListener(Suggestions.enter);

