/* global Module */

Module.register("MMM-FaceTracking", {
  defaults: {
    modelScriptUrl: "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js",
    modelBaseUrl: "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights",
    facingMode: "user",
    cameraWidth: 640,
    cameraHeight: 480,
    updateInterval: 450,
    domUpdateThrottleMs: 350,
    notificationInterval: 1000,
    videoStallThresholdMs: 2000,
    detectionInputSize: 224,
    detectionScoreThreshold: 0.5,
    expressionConfidenceThreshold: 0.38,
    positionSmoothing: 0.65,
    expressionSmoothing: 0.7,
    movementThreshold: 0.018,
    farFaceAreaThreshold: 0.08,
    closeFaceAreaThreshold: 0.2,
    noFaceResetMs: 3000,
    recentMoodLimit: 5,
    hourlyHistoryHours: 168,
    showVideoPreview: false,
    previewWidth: 220,
    broadcastNotifications: true,
    notificationName: "MOOD_GUARD_UPDATE"
  },

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
    this.instanceId = this.identifier || "MMM-FaceTracking";

    this.bootstrapStarted = false;
    this.modelsLoaded = false;
    this.faceApiReady = false;
    this.isSuspended = false;
    this.videoElement = null;
    this.stream = null;
    this.loopTimer = null;
    this.lastDomUpdateAt = 0;
    this.lastBroadcastAt = 0;
    this.lastBroadcastSignature = "";
    this.dom = null;
    this.domNodes = null;
    this.cameraRestartInProgress = false;
    this.lastVideoTime = null;
    this.lastVideoProgressAt = 0;
    this.smoothedFace = null;
    this.smoothedExpressions = null;

    this.state = {
      status: "idle",
      statusMessage: "Waiting for MagicMirror DOM",
      faceCount: 0,
      mood: {
        key: null,
        label: "Unavailable",
        confidence: 0
      },
      tracking: null,
      recentMoods: [],
      hourlyMood: null,
      hourlyMoodDataUrl: "/mood/data?instanceId=" + encodeURIComponent(this.instanceId),
      dashboardUrl: "/mood?instanceId=" + encodeURIComponent(this.instanceId),
      lastSeenAt: null,
      lastUpdatedAt: null
    };

    this.sendSocketNotification("CONFIG", {
      instanceId: this.instanceId,
      hourlyHistoryHours: this.config.hourlyHistoryHours
    });
  },

  getScripts: function () {
    return [this.config.modelScriptUrl];
  },

  getStyles: function () {
    return [this.file("MMM-FaceTracking.css")];
  },

  notificationReceived: function (notification) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.bootstrap();
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "HOURLY_MOOD_SUMMARY" || !payload || payload.instanceId !== this.instanceId) {
      return;
    }

    this.state.hourlyMood = payload.hourlyMood || null;
    if (payload.hourlyMoodDataUrl) {
      this.state.hourlyMoodDataUrl = payload.hourlyMoodDataUrl;
    }
    if (payload.dashboardUrl) {
      this.state.dashboardUrl = payload.dashboardUrl;
    }

    this.broadcastState();
  },

  suspend: function () {
    this.isSuspended = true;
    this.stopDetectionLoop();
    this.stopCamera();
  },

  resume: function () {
    this.isSuspended = false;
    this.bootstrap(true);
  },

  bootstrap: async function (forceRestart) {
    if (this.isSuspended) {
      return;
    }

    if (this.bootstrapStarted && !forceRestart) {
      return;
    }

    this.bootstrapStarted = true;

    try {
      this.setStatus("loading", "Preparing face API");
      await this.waitForFaceApi();

      if (!this.modelsLoaded) {
        this.setStatus("loading", "Loading face and expression models");
        await this.loadModels();
      }

      this.setStatus("loading", "Opening camera");
      await this.startCamera();
      this.startDetectionLoop();
      this.setStatus("tracking", "Camera active");
    } catch (error) {
      this.setError(error);
    }
  },

  waitForFaceApi: function () {
    var self = this;
    if (window.faceapi) {
      self.faceApiReady = true;
      return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
      var attempts = 0;
      var interval = setInterval(function () {
        attempts += 1;
        if (window.faceapi) {
          clearInterval(interval);
          self.faceApiReady = true;
          resolve();
          return;
        }

        if (attempts >= 40) {
          clearInterval(interval);
          reject(new Error("face-api.js failed to load"));
        }
      }, 250);
    });
  },

  loadModels: async function () {
    await Promise.all([
      window.faceapi.nets.tinyFaceDetector.loadFromUri(this.config.modelBaseUrl),
      window.faceapi.nets.faceExpressionNet.loadFromUri(this.config.modelBaseUrl)
    ]);
    this.modelsLoaded = true;
  },

  startCamera: async function () {
    if (this.stream) {
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Browser camera API is not available");
    }

    this.videoElement = this.videoElement || this.createVideoElement();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: this.config.facingMode,
        width: { ideal: this.config.cameraWidth },
        height: { ideal: this.config.cameraHeight }
      }
    });

    await new Promise(function (resolve, reject) {
      var settled = false;
      var video = this.videoElement;

      function cleanup() {
        video.onloadedmetadata = null;
        video.onerror = null;
      }

      function onLoaded() {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      }

      function onError() {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("Unable to read the camera stream"));
      }

      video.onloadedmetadata = onLoaded;
      video.onerror = onError;
      video.srcObject = this.stream;

      if (video.readyState >= 1) {
        onLoaded();
      }
    }.bind(this));

    await this.videoElement.play();
    this.lastVideoTime = null;
    this.lastVideoProgressAt = Date.now();
    this.requestDomUpdate(true);
  },

  createVideoElement: function () {
    var video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.className = "mmm-facetracking__video";
    video.style.width = this.config.previewWidth + "px";
    return video;
  },

  stopCamera: function () {
    if (this.stream) {
      this.stream.getTracks().forEach(function (track) {
        track.stop();
      });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
    }

    this.lastVideoTime = null;
    this.lastVideoProgressAt = 0;
  },

  startDetectionLoop: function () {
    var self = this;

    this.stopDetectionLoop();

    async function tick() {
      if (self.isSuspended || !self.stream || !self.videoElement) {
        return;
      }

      try {
        if (await self.ensureVideoProgress()) {
          if (!self.isSuspended && self.stream) {
            self.loopTimer = setTimeout(tick, self.config.updateInterval);
          }
          return;
        }

        await self.analyseFrame();
      } catch (error) {
        self.setError(error);
        return;
      }

      self.loopTimer = setTimeout(tick, self.config.updateInterval);
    }

    tick();
  },

  stopDetectionLoop: function () {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  },

  ensureVideoProgress: async function () {
    if (!this.videoElement || !this.stream || this.cameraRestartInProgress) {
      return false;
    }

    if (this.videoElement.readyState < 2 || this.videoElement.paused || this.videoElement.ended) {
      this.lastVideoTime = null;
      this.lastVideoProgressAt = Date.now();
      return false;
    }

    var now = Date.now();
    var currentTime = this.videoElement.currentTime || 0;

    if (this.lastVideoTime === null || Math.abs(currentTime - this.lastVideoTime) > 0.001) {
      this.lastVideoTime = currentTime;
      this.lastVideoProgressAt = now;
      return false;
    }

    if (!this.lastVideoProgressAt) {
      this.lastVideoProgressAt = now;
      return false;
    }

    if (now - this.lastVideoProgressAt < this.config.videoStallThresholdMs) {
      return false;
    }

    await this.restartCamera("Video stream stalled, reopening camera");
    return true;
  },

  restartCamera: async function (message) {
    if (this.cameraRestartInProgress || this.isSuspended) {
      return;
    }

    this.cameraRestartInProgress = true;
    this.setStatus("loading", message || "Reopening camera");
    this.stopCamera();

    try {
      await this.startCamera();
      this.setStatus("tracking", "Camera active");
    } catch (error) {
      this.setError(error);
    } finally {
      this.cameraRestartInProgress = false;
    }
  },

  analyseFrame: async function () {
    if (!this.videoElement || this.videoElement.readyState < 2 || !window.faceapi) {
      return;
    }

    var detections = await window.faceapi
      .detectAllFaces(
        this.videoElement,
        new window.faceapi.TinyFaceDetectorOptions({
          inputSize: this.config.detectionInputSize,
          scoreThreshold: this.config.detectionScoreThreshold
        })
      )
      .withFaceExpressions();

    if (!detections.length) {
      this.handleNoFace();
      return;
    }

    var primary = this.selectPrimaryFace(detections);
    var tracking = this.buildTrackingSnapshot(primary.detection);
    var mood = this.buildMoodSnapshot(primary.expressions || {});
    var now = Date.now();

    this.state.faceCount = detections.length;
    this.state.mood = mood;
    this.state.tracking = tracking;
    this.state.lastSeenAt = now;
    this.state.lastUpdatedAt = now;

    this.recordMood(mood, now);
    this.sendHourlyMoodSample(mood, now);
    this.setStatus("tracking", detections.length > 1 ? detections.length + " faces detected" : "Tracking active");
    this.broadcastState();
    this.requestDomUpdate();
  },

  handleNoFace: function () {
    var now = Date.now();
    var stale = !this.state.lastSeenAt || now - this.state.lastSeenAt > this.config.noFaceResetMs;

    this.state.faceCount = 0;
    this.state.lastUpdatedAt = now;

    if (stale) {
      this.smoothedFace = null;
      this.smoothedExpressions = null;
      this.state.mood = {
        key: null,
        label: "Unavailable",
        confidence: 0
      };
      this.state.tracking = null;
    }

    this.setStatus("searching", "Camera active, looking for a face");
    this.broadcastState();
    this.requestDomUpdate();
  },

  selectPrimaryFace: function (detections) {
    return detections.reduce(function (selected, candidate) {
      if (!selected) {
        return candidate;
      }

      var currentBox = selected.detection.box;
      var candidateBox = candidate.detection.box;
      var currentArea = currentBox.width * currentBox.height;
      var candidateArea = candidateBox.width * candidateBox.height;

      return candidateArea > currentArea ? candidate : selected;
    }, null);
  },

  buildTrackingSnapshot: function (detection) {
    var width = this.videoElement.videoWidth || this.config.cameraWidth;
    var height = this.videoElement.videoHeight || this.config.cameraHeight;
    var box = detection.box;
    var raw = {
      centerX: (box.x + box.width / 2) / width,
      centerY: (box.y + box.height / 2) / height,
      area: (box.width * box.height) / (width * height),
      score: detection.score || 0
    };
    var next = this.smoothFace(raw);
    var previous = this.smoothedFace;
    var deltaX = previous ? next.centerX - previous.centerX : 0;
    var deltaY = previous ? next.centerY - previous.centerY : 0;

    this.smoothedFace = next;

    return {
      horizontalZone: this.describeHorizontalZone(next.centerX),
      verticalZone: this.describeVerticalZone(next.centerY),
      movement: this.describeMovement(deltaX, deltaY),
      distance: this.describeDistance(next.area),
      centerX: next.centerX,
      centerY: next.centerY,
      area: next.area,
      detectionScore: next.score
    };
  },

  smoothFace: function (raw) {
    if (!this.smoothedFace) {
      return raw;
    }

    var weight = this.config.positionSmoothing;
    return {
      centerX: this.smoothedFace.centerX * weight + raw.centerX * (1 - weight),
      centerY: this.smoothedFace.centerY * weight + raw.centerY * (1 - weight),
      area: this.smoothedFace.area * weight + raw.area * (1 - weight),
      score: this.smoothedFace.score * weight + raw.score * (1 - weight)
    };
  },

  buildMoodSnapshot: function (expressions) {
    var smoothed = {};
    var weight = this.config.expressionSmoothing;
    var bestKey = "neutral";
    var bestScore = 0;

    this.expressionKeys.forEach(function (key) {
      var rawScore = expressions[key] || 0;
      var previousScore = this.smoothedExpressions ? this.smoothedExpressions[key] || 0 : rawScore;
      var score = this.smoothedExpressions ? previousScore * weight + rawScore * (1 - weight) : rawScore;
      smoothed[key] = score;

      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }, this);

    this.smoothedExpressions = smoothed;

    if (bestScore < this.config.expressionConfidenceThreshold) {
      return {
        key: "uncertain",
        label: this.expressionLabels.uncertain,
        confidence: bestScore
      };
    }

    return {
      key: bestKey,
      label: this.expressionLabels[bestKey] || bestKey,
      confidence: bestScore
    };
  },

  isTrackableMoodSample: function (mood) {
    return !!(
      mood &&
      mood.key &&
      mood.key !== "uncertain" &&
      mood.confidence >= this.config.expressionConfidenceThreshold
    );
  },

  recordMood: function (mood, timestamp) {
    if (!this.isTrackableMoodSample(mood)) {
      return;
    }

    var latest = this.state.recentMoods[0];
    if (latest && latest.key === mood.key) {
      latest.timestamp = timestamp;
      latest.confidence = mood.confidence;
      return;
    }

    this.state.recentMoods.unshift({
      key: mood.key,
      label: mood.label,
      confidence: mood.confidence,
      timestamp: timestamp
    });
    this.state.recentMoods = this.state.recentMoods.slice(0, this.config.recentMoodLimit);
  },

  sendHourlyMoodSample: function (mood, timestamp) {
    if (!this.isTrackableMoodSample(mood)) {
      return;
    }

    this.sendSocketNotification("MOOD_SAMPLE", {
      instanceId: this.instanceId,
      timestamp: timestamp,
      mood: {
        key: mood.key,
        label: mood.label,
        confidence: mood.confidence
      }
    });
  },

  describeHorizontalZone: function (value) {
    if (value < 0.38) {
      return "Left";
    }

    if (value > 0.62) {
      return "Right";
    }

    return "Centered";
  },

  describeVerticalZone: function (value) {
    if (value < 0.38) {
      return "High";
    }

    if (value > 0.62) {
      return "Low";
    }

    return "Level";
  },

  describeDistance: function (area) {
    if (area < this.config.farFaceAreaThreshold) {
      return "Far";
    }

    if (area > this.config.closeFaceAreaThreshold) {
      return "Close";
    }

    return "Comfortable";
  },

  describeMovement: function (deltaX, deltaY) {
    if (Math.abs(deltaX) < this.config.movementThreshold && Math.abs(deltaY) < this.config.movementThreshold) {
      return "Steady";
    }

    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      return deltaX > 0 ? "Moving right" : "Moving left";
    }

    return deltaY > 0 ? "Moving down" : "Moving up";
  },

  setStatus: function (status, message) {
    this.state.status = status;
    this.state.statusMessage = message;
    this.requestDomUpdate();
  },

  setError: function (error) {
    var message = error && error.message ? error.message : "Unknown camera error";
    this.state.status = "error";
    this.state.statusMessage = message;
    this.bootstrapStarted = false;
    this.stopDetectionLoop();
    this.stopCamera();
    this.requestDomUpdate(true);
  },

  broadcastState: function () {
    if (!this.config.broadcastNotifications) {
      return;
    }

    var now = Date.now();
    var payload = {
      instanceId: this.instanceId,
      status: this.state.status,
      statusMessage: this.state.statusMessage,
      faceCount: this.state.faceCount,
      mood: this.state.mood,
      hourlyMood: this.state.hourlyMood,
      hourlyMoodDataUrl: this.state.hourlyMoodDataUrl,
      dashboardUrl: this.state.dashboardUrl,
      tracking: this.state.tracking,
      recentMoods: this.state.recentMoods,
      lastSeenAt: this.state.lastSeenAt,
      lastUpdatedAt: this.state.lastUpdatedAt
    };
    var signature = JSON.stringify({
      status: payload.status,
      faceCount: payload.faceCount,
      mood: payload.mood ? payload.mood.key : null,
      horizontalZone: payload.tracking ? payload.tracking.horizontalZone : null,
      verticalZone: payload.tracking ? payload.tracking.verticalZone : null,
      movement: payload.tracking ? payload.tracking.movement : null
    });

    if (signature === this.lastBroadcastSignature && now - this.lastBroadcastAt < this.config.notificationInterval) {
      return;
    }

    this.lastBroadcastSignature = signature;
    this.lastBroadcastAt = now;
    this.sendNotification(this.config.notificationName, payload);
  },

  requestDomUpdate: function (force) {
    var now = Date.now();
    if (!force && now - this.lastDomUpdateAt < this.config.domUpdateThrottleMs) {
      return;
    }

    this.lastDomUpdateAt = now;

    if (this.dom) {
      this.renderDom();
      return;
    }

    this.updateDom(0);
  },

  getDom: function () {
    if (!this.dom) {
      this.buildDom();
    }

    this.renderDom();
    return this.dom;
  },

  buildDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-facetracking";

    var statusRow = document.createElement("div");
    statusRow.className = "mmm-facetracking__status";

    var dot = document.createElement("span");
    dot.className = "mmm-facetracking__dot";
    statusRow.appendChild(dot);

    var statusText = document.createElement("span");
    statusText.className = "mmm-facetracking__status-text";
    statusRow.appendChild(statusText);

    wrapper.appendChild(statusRow);

    var previewSlot = null;
    if (this.config.showVideoPreview) {
      var preview = document.createElement("div");
      preview.className = "mmm-facetracking__preview";
      previewSlot = document.createElement("div");
      preview.appendChild(previewSlot);
      wrapper.appendChild(preview);
    }

    var moodCard = document.createElement("div");
    moodCard.className = "mmm-facetracking__card";

    var moodTitle = document.createElement("div");
    moodTitle.className = "mmm-facetracking__label";
    moodTitle.innerText = "Estimated mood";
    moodCard.appendChild(moodTitle);

    var moodValue = document.createElement("div");
    moodValue.className = "mmm-facetracking__mood";
    moodCard.appendChild(moodValue);

    var confidence = document.createElement("div");
    confidence.className = "mmm-facetracking__confidence";
    moodCard.appendChild(confidence);

    var meter = document.createElement("div");
    meter.className = "mmm-facetracking__meter";
    var fill = document.createElement("span");
    meter.appendChild(fill);
    moodCard.appendChild(meter);

    wrapper.appendChild(moodCard);

    var stats = document.createElement("div");
    stats.className = "mmm-facetracking__grid";
    var statNodes = {
      faces: this.createStat("Faces"),
      horizontal: this.createStat("X"),
      vertical: this.createStat("Y"),
      distance: this.createStat("Distance"),
      movement: this.createStat("Movement"),
      seen: this.createStat("Seen")
    };
    stats.appendChild(statNodes.faces.item);
    stats.appendChild(statNodes.horizontal.item);
    stats.appendChild(statNodes.vertical.item);
    stats.appendChild(statNodes.distance.item);
    stats.appendChild(statNodes.movement.item);
    stats.appendChild(statNodes.seen.item);
    wrapper.appendChild(stats);

    var history = document.createElement("div");
    history.className = "mmm-facetracking__history";

    var historyLabel = document.createElement("div");
    historyLabel.className = "mmm-facetracking__label";
    historyLabel.innerText = "Recent mood changes";
    history.appendChild(historyLabel);

    var chips = document.createElement("div");
    chips.className = "mmm-facetracking__chips";
    history.appendChild(chips);
    wrapper.appendChild(history);

    this.dom = wrapper;
    this.domNodes = {
      dot: dot,
      statusText: statusText,
      previewSlot: previewSlot,
      moodValue: moodValue,
      confidence: confidence,
      meterFill: fill,
      stats: statNodes,
      history: history,
      chips: chips
    };
  },

  renderDom: function () {
    if (!this.dom || !this.domNodes) {
      return;
    }

    this.domNodes.dot.className = "mmm-facetracking__dot mmm-facetracking__dot--" + this.state.status;
    this.domNodes.statusText.innerText = this.state.statusMessage;

    if (this.domNodes.previewSlot) {
      if (this.videoElement) {
        if (this.videoElement.parentNode !== this.domNodes.previewSlot) {
          while (this.domNodes.previewSlot.firstChild) {
            this.domNodes.previewSlot.removeChild(this.domNodes.previewSlot.firstChild);
          }
          this.domNodes.previewSlot.appendChild(this.videoElement);
        }
      } else {
        while (this.domNodes.previewSlot.firstChild) {
          this.domNodes.previewSlot.removeChild(this.domNodes.previewSlot.firstChild);
        }
      }
    }

    this.domNodes.moodValue.innerText = this.state.mood.label;
    this.domNodes.confidence.innerText = "Confidence " + this.percent(this.state.mood.confidence);
    this.domNodes.meterFill.style.width = Math.round((this.state.mood.confidence || 0) * 100) + "%";

    this.domNodes.stats.faces.value.innerText = String(this.state.faceCount);
    this.domNodes.stats.horizontal.value.innerText = this.state.tracking ? this.state.tracking.horizontalZone : "--";
    this.domNodes.stats.vertical.value.innerText = this.state.tracking ? this.state.tracking.verticalZone : "--";
    this.domNodes.stats.distance.value.innerText = this.state.tracking ? this.state.tracking.distance : "--";
    this.domNodes.stats.movement.value.innerText = this.state.tracking ? this.state.tracking.movement : "--";
    this.domNodes.stats.seen.value.innerText = this.state.lastSeenAt ? this.relativeTime(this.state.lastSeenAt) : "--";

    this.domNodes.history.style.display = this.state.recentMoods.length ? "" : "none";
    while (this.domNodes.chips.firstChild) {
      this.domNodes.chips.removeChild(this.domNodes.chips.firstChild);
    }

    this.state.recentMoods.forEach(function (entry) {
      var chip = document.createElement("span");
      chip.className = "mmm-facetracking__chip";
      chip.innerText = entry.label;
      this.domNodes.chips.appendChild(chip);
    }, this);
  },

  createStat: function (label) {
    var item = document.createElement("div");
    item.className = "mmm-facetracking__stat";

    var title = document.createElement("span");
    title.className = "mmm-facetracking__stat-label";
    title.innerText = label;
    item.appendChild(title);

    var body = document.createElement("span");
    body.className = "mmm-facetracking__stat-value";
    item.appendChild(body);

    return {
      item: item,
      value: body
    };
  },

  percent: function (value) {
    return Math.round((value || 0) * 100) + "%";
  },

  relativeTime: function (timestamp) {
    var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 2) {
      return "Now";
    }

    return seconds + "s ago";
  }
});
