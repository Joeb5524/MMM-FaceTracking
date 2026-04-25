(function () {
  var moodOrder = [
    "neutral",
    "happy",
    "sad",
    "angry",
    "fearful",
    "disgusted",
    "surprised"
  ];
  var moodColors = {
    neutral: "var(--neutral)",
    happy: "var(--happy)",
    sad: "var(--sad)",
    angry: "var(--angry)",
    fearful: "var(--fearful)",
    disgusted: "var(--disgusted)",
    surprised: "var(--surprised)"
  };
  var searchParams = new URLSearchParams(window.location.search);
  var state = {
    selectedInstanceId: searchParams.get("instanceId") || "all"
  };
  var elements = {
    instanceSelect: document.getElementById("instance-select"),
    lastUpdated: document.getElementById("last-updated"),
    dominant: document.getElementById("summary-dominant"),
    dominantMeta: document.getElementById("summary-dominant-meta"),
    samples: document.getElementById("summary-samples"),
    hours: document.getElementById("summary-hours"),
    hoursMeta: document.getElementById("summary-hours-meta"),
    chart: document.getElementById("chart"),
    chartEmpty: document.getElementById("chart-empty"),
    chartSubtitle: document.getElementById("chart-subtitle"),
    legend: document.getElementById("legend"),
    tableWrap: document.getElementById("table-wrap")
  };

  function formatHour(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatPercent(value) {
    return Math.round((value || 0) * 100) + "%";
  }

  function buildApiUrl() {
    if (!state.selectedInstanceId || state.selectedInstanceId === "all") {
      return "/mood/data";
    }

    return "/mood/data?instanceId=" + encodeURIComponent(state.selectedInstanceId);
  }

  function updateQueryString() {
    var url = new URL(window.location.href);
    if (!state.selectedInstanceId || state.selectedInstanceId === "all") {
      url.searchParams.delete("instanceId");
    } else {
      url.searchParams.set("instanceId", state.selectedInstanceId);
    }

    window.history.replaceState({}, "", url.toString());
  }

  function createLegend() {
    elements.legend.innerHTML = "";

    moodOrder.forEach(function (moodKey) {
      var item = document.createElement("div");
      item.className = "mood-legend__item";

      var swatch = document.createElement("span");
      swatch.className = "mood-legend__swatch";
      swatch.style.background = moodColors[moodKey];
      item.appendChild(swatch);

      var text = document.createElement("span");
      text.textContent = titleCase(moodKey === "disgusted" ? "discomfort" : moodKey);
      item.appendChild(text);

      elements.legend.appendChild(item);
    });
  }

  function titleCase(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function populateInstanceSelect(availableInstances) {
    var desiredSelection = state.selectedInstanceId || "all";
    var options = [{
      value: "all",
      label: "Combined"
    }].concat((availableInstances || []).map(function (item) {
      return {
        value: item.instanceId,
        label: item.instanceId
      };
    }));

    elements.instanceSelect.innerHTML = "";
    options.forEach(function (optionData) {
      var option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.label;
      elements.instanceSelect.appendChild(option);
    });

    if (!options.some(function (optionData) { return optionData.value === desiredSelection; })) {
      desiredSelection = "all";
      state.selectedInstanceId = "all";
      updateQueryString();
    }

    elements.instanceSelect.value = desiredSelection;
  }

  function renderSummary(payload) {
    var currentHour = payload.currentHour;
    var trackedHours = payload.hours || [];
    var dominantMood = currentHour && currentHour.dominantMood ? currentHour.dominantMood : null;
    var activeSource = payload.instanceId || "Combined";

    elements.dominant.textContent = dominantMood ? dominantMood.label : "No data";
    elements.dominantMeta.textContent = dominantMood
      ? formatPercent(dominantMood.share) + " of valid samples in the current hour"
      : "No valid mood samples in the current hour";
    elements.samples.textContent = String(currentHour ? currentHour.totalSamples : 0);
    elements.hours.textContent = String(trackedHours.length);
    elements.hoursMeta.textContent = trackedHours.length
      ? "Showing " + activeSource + " across " + trackedHours.length + " hour buckets"
      : "Waiting for recorded mood samples";
    elements.chartSubtitle.textContent = trackedHours.length
      ? "Updated " + formatDateTime(payload.generatedAt)
      : "";
    elements.lastUpdated.textContent = trackedHours.length
      ? "Viewing " + activeSource + " data, refreshed " + formatDateTime(payload.generatedAt)
      : "Waiting for mood data";
  }

  function renderChart(hours) {
    elements.chart.innerHTML = "";

    if (!hours || !hours.length) {
      elements.chart.hidden = true;
      elements.chartEmpty.hidden = false;
      return;
    }

    elements.chart.hidden = false;
    elements.chartEmpty.hidden = true;

    hours.forEach(function (hour) {
      var hourWrap = document.createElement("div");
      hourWrap.className = "mood-chart__hour";

      var bar = document.createElement("div");
      bar.className = "mood-chart__bar";
      bar.title = buildHourTooltip(hour);

      moodOrder.forEach(function (moodKey) {
        var mood = hour.moods[moodKey];
        if (!mood || !mood.samples) {
          return;
        }

        var segment = document.createElement("div");
        segment.className = "mood-chart__segment";
        segment.dataset.mood = moodKey;
        segment.style.height = (mood.share * 100) + "%";
        segment.style.background = moodColors[moodKey];
        segment.title = buildMoodTooltip(hour, mood);
        bar.appendChild(segment);
      });

      hourWrap.appendChild(bar);

      var label = document.createElement("div");
      label.className = "mood-chart__hour-label";
      label.textContent = formatHour(hour.hourStart);
      hourWrap.appendChild(label);

      var meta = document.createElement("div");
      meta.className = "mood-chart__hour-meta";
      meta.textContent = hour.totalSamples + " samples";
      hourWrap.appendChild(meta);

      elements.chart.appendChild(hourWrap);
    });
  }

  function buildHourTooltip(hour) {
    if (!hour.dominantMood) {
      return formatDateTime(hour.hourStart) + " - no dominant mood";
    }

    return formatDateTime(hour.hourStart) +
      " - " +
      hour.dominantMood.label +
      " (" +
      formatPercent(hour.dominantMood.share) +
      ", " +
      hour.totalSamples +
      " samples)";
  }

  function buildMoodTooltip(hour, mood) {
    return formatDateTime(hour.hourStart) +
      " - " +
      mood.label +
      ": " +
      mood.samples +
      " samples, " +
      formatPercent(mood.share) +
      ", avg confidence " +
      formatPercent(mood.averageConfidence);
  }

  function renderTable(hours) {
    elements.tableWrap.innerHTML = "";

    if (!hours || !hours.length) {
      var empty = document.createElement("div");
      empty.className = "mood-empty";
      empty.textContent = "No hourly mood samples have been recorded yet.";
      elements.tableWrap.appendChild(empty);
      return;
    }

    var table = document.createElement("table");
    table.className = "mood-table";

    var header = document.createElement("thead");
    header.innerHTML = [
      "<tr>",
      "<th>Hour</th>",
      "<th>Dominant mood</th>",
      "<th>Share</th>",
      "<th>Samples</th>",
      "</tr>"
    ].join("");
    table.appendChild(header);

    var body = document.createElement("tbody");
    hours.slice().reverse().forEach(function (hour) {
      var row = document.createElement("tr");
      var dominantMood = hour.dominantMood;
      var moodCell = dominantMood ? buildMoodPill(dominantMood) : "No data";

      row.innerHTML = [
        "<td>" + formatDateTime(hour.hourStart) + "</td>",
        "<td>" + moodCell + "</td>",
        "<td>" + (dominantMood ? formatPercent(dominantMood.share) : "--") + "</td>",
        "<td>" + hour.totalSamples + "</td>"
      ].join("");
      body.appendChild(row);
    });

    table.appendChild(body);
    elements.tableWrap.appendChild(table);
  }

  function buildMoodPill(mood) {
    return [
      '<span class="mood-pill">',
      '<span class="mood-pill__dot" style="background:' + moodColors[mood.key] + '"></span>',
      '<span>' + mood.label + "</span>",
      "</span>"
    ].join("");
  }

  function render(payload) {
    populateInstanceSelect(payload.availableInstances || []);
    renderSummary(payload);
    renderChart(payload.hours || []);
    renderTable(payload.hours || []);
  }

  function fetchData() {
    fetch(buildApiUrl(), {
      cache: "no-store"
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Request failed with status " + response.status);
        }

        return response.json();
      })
      .then(render)
      .catch(function (error) {
        elements.lastUpdated.textContent = error.message;
      });
  }

  elements.instanceSelect.addEventListener("change", function (event) {
    state.selectedInstanceId = event.target.value || "all";
    updateQueryString();
    fetchData();
  });

  createLegend();
  fetchData();
  window.setInterval(fetchData, 15000);
})();
