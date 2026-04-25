const fs = require("fs");
const path = require("path");
const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
  start: function () {
    this.expressionKeys = [
      "neutral",
      "happy",
      "sad",
      "angry",
      "fearful",
      "disgusted",
      "surprised"
    ];
    this.expressionLabels = {
      neutral: "Neutral",
      happy: "Happy",
      sad: "Sad",
      angry: "Angry",
      fearful: "Fearful",
      disgusted: "Discomfort",
      surprised: "Surprised",
      uncertain: "Uncertain"
    };
    this.instanceConfigs = {};
    this.instanceStores = {};
    this.persistTimer = null;
    this.persistDebounceMs = 5000;
    this.dataDirectory = path.join(this.path, "data");
    this.dataFile = path.join(this.dataDirectory, "mood-history.json");

    this.loadPersistedData();
    this.registerRoutes();
  },

  stop: function () {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.persistData();
  },

  socketNotificationReceived: function (notification, payload) {
    var data = payload || {};
    var instanceId = data.instanceId || "default";

    if (notification === "CONFIG") {
      this.instanceConfigs[instanceId] = {
        hourlyHistoryHours: this.parseHourlyHistoryHours(data.hourlyHistoryHours)
      };
      this.pruneInstanceStore(instanceId);
      this.publishHourlySummary(instanceId);
      return;
    }

    if (notification === "REQUEST_HOURLY_MOOD_SUMMARY") {
      this.publishHourlySummary(instanceId);
      return;
    }

    if (notification === "MOOD_SAMPLE") {
      if (!this.isValidMoodSample(data.mood)) {
        return;
      }

      this.recordMoodSample(instanceId, data.mood, data.timestamp);
      this.publishHourlySummary(instanceId);
    }
  },

  registerRoutes: function () {
    var dashboardFile = path.join(this.path, "public", "mood-dashboard.html");

    this.expressApp.get("/mood", function (req, res) {
      res.sendFile(dashboardFile);
    });

    this.expressApp.get("/mood/data", function (req, res) {
      res.json(this.buildApiResponse(req.query.instanceId || null));
    }.bind(this));
  },

  parseHourlyHistoryHours: function (value) {
    var parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
  },

  isValidMoodSample: function (mood) {
    return !!(
      mood &&
      mood.key &&
      mood.key !== "uncertain" &&
      typeof mood.confidence === "number" &&
      mood.confidence >= 0
    );
  },

  getHourStart: function (timestamp) {
    var date = new Date(timestamp || Date.now());
    date.setMinutes(0, 0, 0);
    return date.getTime();
  },

  getRetentionCutoff: function (instanceId) {
    var config = this.instanceConfigs[instanceId] || {};
    var historyHours = this.parseHourlyHistoryHours(config.hourlyHistoryHours);
    return this.getHourStart(Date.now()) - (historyHours - 1) * 60 * 60 * 1000;
  },

  ensureInstanceStore: function (instanceId) {
    if (!this.instanceStores[instanceId]) {
      this.instanceStores[instanceId] = {
        instanceId: instanceId,
        lastUpdatedAt: null,
        buckets: {}
      };
    }

    return this.instanceStores[instanceId];
  },

  createBucket: function (hourStart) {
    return {
      hourStart: hourStart,
      totalSamples: 0,
      moods: {}
    };
  },

  recordMoodSample: function (instanceId, mood, timestamp) {
    var recordedAt = typeof timestamp === "number" ? timestamp : Date.now();
    var hourStart = this.getHourStart(recordedAt);
    var store = this.ensureInstanceStore(instanceId);
    var bucketKey = String(hourStart);
    var bucket = store.buckets[bucketKey] || this.createBucket(hourStart);
    var moodBucket = bucket.moods[mood.key] || {
      samples: 0,
      confidenceTotal: 0
    };

    moodBucket.samples += 1;
    moodBucket.confidenceTotal += mood.confidence;
    bucket.moods[mood.key] = moodBucket;
    bucket.totalSamples += 1;
    store.buckets[bucketKey] = bucket;
    store.lastUpdatedAt = recordedAt;

    this.pruneInstanceStore(instanceId);
    this.schedulePersist();
  },

  pruneInstanceStore: function (instanceId) {
    var store = this.instanceStores[instanceId];
    if (!store) {
      return;
    }

    var cutoff = this.getRetentionCutoff(instanceId);
    Object.keys(store.buckets).forEach(function (bucketKey) {
      if (store.buckets[bucketKey].hourStart < cutoff) {
        delete store.buckets[bucketKey];
      }
    });
  },

  pruneAllStores: function () {
    Object.keys(this.instanceStores).forEach(function (instanceId) {
      this.pruneInstanceStore(instanceId);
    }, this);
  },

  schedulePersist: function () {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(function () {
      this.persistTimer = null;
      this.persistData();
    }.bind(this), this.persistDebounceMs);
  },

  persistData: function () {
    this.pruneAllStores();
    fs.mkdirSync(this.dataDirectory, { recursive: true });

    var payload = {
      version: 1,
      savedAt: Date.now(),
      instanceStores: this.instanceStores
    };
    var tempFile = this.dataFile + ".tmp";

    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tempFile, this.dataFile);
  },

  loadPersistedData: function () {
    if (!fs.existsSync(this.dataFile)) {
      return;
    }

    try {
      var raw = fs.readFileSync(this.dataFile, "utf8");
      var parsed = JSON.parse(raw);
      this.instanceStores = parsed.instanceStores || {};
      this.pruneAllStores();
    } catch (error) {
      console.error("MMM-FaceTracking: failed to load persisted mood history", error);
      this.instanceStores = {};
    }
  },

  buildMoodSummary: function (bucket, moodKey) {
    var moodBucket = bucket.moods[moodKey] || {
      samples: 0,
      confidenceTotal: 0
    };
    var samples = moodBucket.samples || 0;
    var averageConfidence = samples ? moodBucket.confidenceTotal / samples : 0;

    return {
      key: moodKey,
      label: this.expressionLabels[moodKey] || moodKey,
      samples: samples,
      share: bucket.totalSamples ? samples / bucket.totalSamples : 0,
      averageConfidence: averageConfidence
    };
  },

  buildHourSummary: function (bucket) {
    var moods = {};
    var dominantMood = null;

    this.expressionKeys.forEach(function (moodKey) {
      var summary = this.buildMoodSummary(bucket, moodKey);
      moods[moodKey] = summary;

      if (
        !dominantMood ||
        summary.samples > dominantMood.samples ||
        (summary.samples === dominantMood.samples && summary.averageConfidence > dominantMood.averageConfidence)
      ) {
        dominantMood = summary;
      }
    }, this);

    return {
      hourStart: bucket.hourStart,
      totalSamples: bucket.totalSamples,
      dominantMood: dominantMood && dominantMood.samples ? dominantMood : null,
      moods: moods
    };
  },

  getInstanceHourSummaries: function (instanceId) {
    var store = this.instanceStores[instanceId];
    if (!store) {
      return [];
    }

    return Object.keys(store.buckets)
      .map(function (bucketKey) {
        return this.buildHourSummary(store.buckets[bucketKey]);
      }, this)
      .sort(function (left, right) {
        return left.hourStart - right.hourStart;
      });
  },

  getCombinedHourSummaries: function () {
    var combinedBuckets = {};

    Object.keys(this.instanceStores).forEach(function (instanceId) {
      var store = this.instanceStores[instanceId];
      Object.keys(store.buckets).forEach(function (bucketKey) {
        var bucket = store.buckets[bucketKey];
        var combined = combinedBuckets[bucketKey] || this.createBucket(bucket.hourStart);

        combined.totalSamples += bucket.totalSamples;
        Object.keys(bucket.moods).forEach(function (moodKey) {
          var sourceMood = bucket.moods[moodKey];
          var targetMood = combined.moods[moodKey] || {
            samples: 0,
            confidenceTotal: 0
          };

          targetMood.samples += sourceMood.samples || 0;
          targetMood.confidenceTotal += sourceMood.confidenceTotal || 0;
          combined.moods[moodKey] = targetMood;
        });

        combinedBuckets[bucketKey] = combined;
      }, this);
    }, this);

    return Object.keys(combinedBuckets)
      .map(function (bucketKey) {
        return this.buildHourSummary(combinedBuckets[bucketKey]);
      }, this)
      .sort(function (left, right) {
        return left.hourStart - right.hourStart;
      });
  },

  getCurrentHourSummary: function (instanceId) {
    var store = this.instanceStores[instanceId];
    if (!store) {
      return null;
    }

    var currentBucket = store.buckets[String(this.getHourStart(Date.now()))];
    return currentBucket ? this.buildHourSummary(currentBucket) : null;
  },

  getCurrentCombinedHourSummary: function () {
    var currentHourKey = String(this.getHourStart(Date.now()));
    var combinedBucket = null;

    Object.keys(this.instanceStores).forEach(function (instanceId) {
      var store = this.instanceStores[instanceId];
      var bucket = store.buckets[currentHourKey];
      if (!bucket) {
        return;
      }

      combinedBucket = combinedBucket || this.createBucket(bucket.hourStart);
      combinedBucket.totalSamples += bucket.totalSamples;

      Object.keys(bucket.moods).forEach(function (moodKey) {
        var sourceMood = bucket.moods[moodKey];
        var targetMood = combinedBucket.moods[moodKey] || {
          samples: 0,
          confidenceTotal: 0
        };

        targetMood.samples += sourceMood.samples || 0;
        targetMood.confidenceTotal += sourceMood.confidenceTotal || 0;
        combinedBucket.moods[moodKey] = targetMood;
      });
    }, this);

    return combinedBucket ? this.buildHourSummary(combinedBucket) : null;
  },

  buildDataUrl: function (instanceId) {
    if (!instanceId) {
      return "/mood/data";
    }

    return "/mood/data?instanceId=" + encodeURIComponent(instanceId);
  },

  buildDashboardUrl: function (instanceId) {
    if (!instanceId) {
      return "/mood";
    }

    return "/mood?instanceId=" + encodeURIComponent(instanceId);
  },

  buildApiResponse: function (instanceId) {
    var normalizedInstanceId = instanceId && instanceId !== "all" ? instanceId : null;
    var useInstance = normalizedInstanceId && this.instanceStores[normalizedInstanceId];
    var hours = useInstance ? this.getInstanceHourSummaries(normalizedInstanceId) : this.getCombinedHourSummaries();
    var selectedInstanceId = useInstance ? normalizedInstanceId : null;
    var currentHour = selectedInstanceId
      ? this.getCurrentHourSummary(selectedInstanceId)
      : this.getCurrentCombinedHourSummary();

    return {
      generatedAt: Date.now(),
      mode: selectedInstanceId ? "instance" : "combined",
      instanceId: selectedInstanceId,
      currentHour: currentHour,
      hours: hours,
      dashboardUrl: this.buildDashboardUrl(selectedInstanceId),
      apiUrl: this.buildDataUrl(selectedInstanceId),
      availableInstances: Object.keys(this.instanceStores)
        .sort()
        .map(function (availableId) {
          var store = this.instanceStores[availableId];
          return {
            instanceId: availableId,
            lastUpdatedAt: store.lastUpdatedAt,
            hours: Object.keys(store.buckets || {}).length
          };
        }, this)
    };
  },

  publishHourlySummary: function (instanceId) {
    this.sendSocketNotification("HOURLY_MOOD_SUMMARY", {
      instanceId: instanceId,
      hourlyMood: this.getCurrentHourSummary(instanceId),
      dashboardUrl: this.buildDashboardUrl(instanceId),
      hourlyMoodDataUrl: this.buildDataUrl(instanceId)
    });
  }
});
