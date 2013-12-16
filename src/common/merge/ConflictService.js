(function() {
  var module = angular.module('loom_conflict_service', []);

  // Private Variables
  var featureDiffService_ = null;
  var diffService_ = null;
  var pulldownService_ = null;
  var service_ = null;
  var mapService_ = null;
  var dialogService_ = null;
  var geogitService_ = null;
  var translate_ = null;

  module.provider('conflictService', function() {
    this.features = null;
    this.ours = null;
    this.theirs = null;
    this.ancestor = null;
    this.repoId = null;
    this.currentFeature = null;
    this.ourName = null;
    this.theirName = null;
    this.transaction = null;
    this.mergeBranch = null;

    this.$get = function($rootScope, $location, $translate, diffService, pulldownService,
                         featureDiffService, mapService, dialogService, geogitService) {
      diffService_ = diffService;
      pulldownService_ = pulldownService;
      featureDiffService_ = featureDiffService;
      mapService_ = mapService;
      dialogService_ = dialogService;
      geogitService_ = geogitService;
      translate_ = $translate;
      service_ = this;
      return this;
    };

    this.abort = function() {
      if (goog.isDefAndNotNull(this.transaction)) {
        this.transaction.abort();
        this.transaction = null;
      }
      this.features = null;
      this.ours = null;
      this.ancestor = null;
      this.repoId = null;
      this.currentFeature = null;
      this.ourName = null;
      this.theirName = null;
    };

    this.selectFeature = function(index) {
      this.currentFeature = this.features[index];
    };

    this.resolveConflict = function(merges) {
      this.currentFeature.resolved = true;
      this.currentFeature.merges = merges;
      diffService_.resolveFeature(this.currentFeature);
    };

    this.beginResolution = function() {
      if (!goog.isArray(service_.features)) {
        service_.features = [service_.features];
      }
      diffService_.setTitle(translate_('merge_results'));
      diffService_.clickCallback = featureClicked;
      diffService_.mergeDiff = true;
      diffService_.populate(service_.features,
          geogitService_.getRepoById(service_.repoId).name, service_.ourName, service_.theirName);
      pulldownService_.conflictsMode();
    };

    this.commit = function() {
      var conflicts = [];
      var i;
      for (i = 0; i < service_.features.length; i++) {
        var feature = service_.features[i];
        if (feature.change === 'CONFLICT') {
          conflicts.push(feature);
        }
      }

      var conflictsInError = 0;
      commitInternal(conflicts, conflictsInError);
    };

    this.buildMergeMessage = function(status, mergeBranch, useConflicts) {
      var message = {};
      message.merge_branch = mergeBranch;
      if (goog.isDefAndNotNull(status.staged)) {

        forEachArrayish(status.staged, function(entry) {
          var layer = null;
          if (goog.isDefAndNotNull(entry.path) && entry.path.length > 0) {
            layer = entry.path.split('/')[0];
          } else {
            layer = entry.newPath.split('/')[0];
          }
          if (!goog.isDefAndNotNull(message[layer])) {
            message[layer] = {};
          }
          switch (entry.changeType) {
            case 'ADDED':
              if (!goog.isDefAndNotNull(message[layer].added)) {
                message[layer].added = 0;
              }
              message[layer].added++;
              break;
            case 'REMOVED':
              if (!goog.isDefAndNotNull(message[layer].removed)) {
                message[layer].removed = 0;
              }
              message[layer].removed++;
              break;
            case 'MODIFIED':
              if (!goog.isDefAndNotNull(message[layer].modified)) {
                message[layer].modified = 0;
              }
              message[layer].modified++;
              break;
          }
        });
        if (goog.isDefAndNotNull(useConflicts) && useConflicts === true) {
          for (i = 0; i < service_.features.length; i++) {
            var feature = service_.features[i];
            if (feature.change === 'CONFLICT') {
              var layer = feature.id.split('/')[0];
              if (!goog.isDefAndNotNull(message[layer])) {
                message[layer] = {};
              }
              if (!goog.isDefAndNotNull(message[layer].conflicted)) {
                message[layer].conflicted = [];
              }
              message[layer].conflicted.push(feature.id);
            }
          }
        }
      }
      return JSON.stringify(message);
    };
  });

  function featureClicked(feature) {
    var fid = feature.layer + '/' + feature.feature;
    for (var i = 0; i < service_.features.length; i++) {
      if (fid === service_.features[i].id) {
        featureDiffService_.leftName = service_.ourName;
        featureDiffService_.rightName = service_.theirName;
        featureDiffService_.setFeature(
            service_.features[i], service_.ours, service_.theirs, service_.ancestor, 'WORK_HEAD', service_.repoId);
        $('#feature-diff-dialog').modal('show');
        service_.currentFeature = service_.features[i];
        break;
      }
    }
  }

  function commitInternal(conflictList, conflictsInError) {
    if (conflictList.length === 0) {
      if (conflictsInError === 0) {
        service_.transaction.command('status').then(function(response) {
          var commitOptions = new GeoGitCommitOptions();
          commitOptions.all = true;
          commitOptions.message = service_.buildMergeMessage(response, service_.mergeBranch, true);
          service_.transaction.command('commit', commitOptions).then(function() {
            // commit successful
            service_.transaction.finalize().then(function() {
              // transaction complete
              diffService_.clearDiff();
              service_.transaction = null;
              service_.abort();
              pulldownService_.defaultMode();
              mapService_.dumpTileCache();
            }, function(endTransactionFailure) {
              if (goog.isObject(endTransactionFailure) &&
                  goog.isDefAndNotNull(endTransactionFailure.conflicts)) {
                handleConflicts(endTransactionFailure);
              } else {
                dialogService_.error(translate_('error'), translate_('conflict_unknown_error'));
                console.log('ERROR: EndTransaction failure: ', endTransactionFailure);
              }
            });
          }, function(reject) {
            // couldn't commit
            dialogService_.error(translate_('error'), translate_('conflict_unknown_error'));
            console.log('ERROR: Failed to commit merge: ', reject);
          });
        }, function(reject) {
        });
      } else {
        // couldn't resolve all conflicts
        dialogService_.error(translate_('error'), translate_('unable_to_resolve_conflicts', {value: conflictsInError}));
        console.log('ERROR: ' + conflictsInError + ' conflicts could not be resolved.');
      }
    } else {
      var conflict = conflictList.pop();

      var resolveConflict = {
        path: conflict.id,
        ours: service_.ours,
        theirs: service_.theirs,
        merges: conflict.merges
      };

      geogitService_.post(service_.repoId, 'repo/mergefeature', resolveConflict).then(function(response) {
        var resolveConflictOptions = new GeoGitResolveConflictOptions();
        resolveConflictOptions.path = conflict.id;
        resolveConflictOptions.objectid = response.data;
        service_.transaction.command('resolveconflict', resolveConflictOptions).then(function() {
          // success
          commitInternal(conflictList, conflictsInError);
        }, function(reject) {
          commitInternal(conflictList, conflictsInError + 1);
          console.log('ERROR: Failed to resolve the conflict: ', conflict, reject);
        });
      }, function(reject) {
        commitInternal(conflictList, conflictsInError + 1);
        console.log('ERROR: Failed to merge the conflicted feature: ', conflict, reject);
      });
    }
  }

  function handleConflicts(mergeFailure) {
    var myDialog = dialogService_.warn(translate_('merge_conflicts'), translate_('conflicts_encountered'),
        [translate_('abort'), translate_('resolve_conflicts')], false);

    myDialog.then(function(button) {
      switch (button) {
        case 0:
          service_.transaction.abort();
          break;
        case 1:
          service_.ourName = translate_('transaction');
          service_.theirName = translate_('repository');
          service_.ours = mergeFailure.ours;
          service_.theirs = mergeFailure.theirs;
          service_.ancestor = mergeFailure.ancestor;
          service_.features = mergeFailure.Feature;
          service_.mergeBranch = translate_('transaction');
          service_.beginResolution();
          break;
      }
    });
  }
}());
