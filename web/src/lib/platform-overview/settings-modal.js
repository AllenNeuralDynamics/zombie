/**
 * lib/platform-overview/settings-modal.js — "Overview Settings" modal for the
 * platform overview (date range, QC group/tag settings, session-summary
 * grouping and instrument/experimenter filters).
 *
 * Wires the gear button to a modal that mutates the shared `settings` object
 * and drives the QC-metrics and session-summary dropdowns via their APIs.
 *
 * @module
 */

/**
 * @param {object} ctx  Shared overview context ({ settings, persist }).
 * @param {object} deps
 * @param {HTMLElement} deps.gearBtn   The gear button that opens the modal.
 * @param {object} deps.qcApi          QC-metrics dropdown API.
 * @param {object} deps.summaryApi     Session-summary dropdown API.
 */
export function createSettingsModal(ctx, { gearBtn, qcApi, summaryApi }) {
  const { settings, persist } = ctx;

  let modalOpen = false;
  let modal = null;

  function openSettingsModal() {
    if (modalOpen) {
      closeModal();
      return;
    }

    modal = document.createElement('div');
    modal.className = 'assets-settings-modal';

    const content = document.createElement('div');
    content.className = 'settings-modal-content';
    modal.appendChild(content);

    const modalHeader = document.createElement('div');
    modalHeader.className = 'settings-modal-header';
    const title = document.createElement('h3');
    title.textContent = 'Overview Settings';
    modalHeader.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-modal-close-btn';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeModal);
    modalHeader.appendChild(closeBtn);
    content.appendChild(modalHeader);

    // ── Group-by radios ────────────────────────────────────────────────────
    const grpSection = document.createElement('div');
    grpSection.className = 'settings-section';

    const grpLabel = document.createElement('div');
    grpLabel.className = 'settings-section-label';
    grpLabel.textContent = 'Group rows by';
    grpSection.appendChild(grpLabel);

    for (const [val, text] of [['rig', 'Rig'], ['experimenter', 'Experimenter']]) {
      const lbl = document.createElement('label');
      lbl.className = 'settings-checkbox-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'platform-ov-groupby';
      radio.value = val;
      radio.checked = settings.groupBy === val;
      radio.addEventListener('change', () => {
        if (radio.checked && val !== settings.groupBy) {
          settings.groupBy = val;
          persist();
          qcApi.updateLabel();
          qcApi.tableApi.setGroupBy(val);
        }
      });
      const span = document.createElement('span');
      span.textContent = text;
      lbl.appendChild(radio);
      lbl.appendChild(span);
      grpSection.appendChild(lbl);
    }
    // grpSection appended to qcBox below

    // ── Date range ─────────────────────────────────────────────────────────────────────
    const sinceSection = document.createElement('div');
    sinceSection.className = 'settings-section';

    const sinceLabel = document.createElement('div');
    sinceLabel.className = 'settings-section-label';
    sinceLabel.textContent = 'Show assets since';
    sinceSection.appendChild(sinceLabel);

    const PRESETS = [
      { label: '\u2014 Quick select \u2014', months: null },
      { label: 'Last month',       months: 1 },
      { label: 'Last 3 months',    months: 3 },
      { label: 'Last 6 months',    months: 6 },
      { label: 'Last year',        months: 12 },
      { label: 'All time',         months: 0 },
    ];
    function computePresetDate(months) {
      if (!months) return '';
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      return d.toISOString().slice(0, 10);
    }

    const presetSelect = document.createElement('select');
    presetSelect.className = 'settings-since-select';
    for (const p of PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.months === null ? '__placeholder__' : (p.months === 0 ? '' : String(p.months));
      opt.textContent = p.label;
      if (p.months === null) { opt.disabled = true; opt.hidden = true; }
      presetSelect.appendChild(opt);
    }
    presetSelect.value = '__placeholder__';

    const sinceRow = document.createElement('div');
    sinceRow.className = 'settings-since-row';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'settings-since-date';
    dateInput.value = settings.since ?? '';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'settings-metric-btn';
    clearBtn.textContent = 'All time';

    sinceRow.appendChild(dateInput);
    sinceRow.appendChild(clearBtn);

    presetSelect.addEventListener('change', () => {
      const val = presetSelect.value;
      if (val === '__placeholder__') return;
      const months = val === '' ? 0 : Number(val);
      dateInput.value = computePresetDate(months);
      settings.since = dateInput.value || null;
      presetSelect.value = '__placeholder__';
      persist();
      qcApi.tableApi.setSince(settings.since);
      summaryApi.refresh();
    });

    dateInput.addEventListener('change', () => {
      settings.since = dateInput.value || null;
      persist();
      qcApi.tableApi.setSince(settings.since);
      summaryApi.refresh();
    });

    clearBtn.addEventListener('click', () => {
      dateInput.value = '';
      settings.since = null;
      persist();
      qcApi.tableApi.setSince(null);
      summaryApi.refresh();
    });

    sinceSection.appendChild(presetSelect);
    sinceSection.appendChild(sinceRow);
    content.appendChild(sinceSection);

    // ── Tag column filter (previously 'Metric filter') ──────────────────────
    const statusSection = document.createElement('div');
    statusSection.className = 'settings-section';

    const statusLabel = document.createElement('div');
    statusLabel.className = 'settings-section-label';
    statusLabel.textContent = 'Show tag columns';
    statusSection.appendChild(statusLabel);

    function buildCheckboxes() {
      const allMetrics = qcApi.getMetrics();
      // Remove all children after the label
      while (statusSection.children.length > 1) {
        statusSection.removeChild(statusSection.lastChild);
      }

      if (!allMetrics.length) {
        const note = document.createElement('p');
        note.className = 'settings-loading-note';
        note.textContent = 'Loading metrics…';
        statusSection.appendChild(note);
        return;
      }

      // Search box
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search metrics…';
      searchInput.className = 'settings-metric-search';
      statusSection.appendChild(searchInput);

      // Select / Clear buttons
      const btnRow = document.createElement('div');
      btnRow.className = 'settings-metric-btn-row';
      const selAllBtn = document.createElement('button');
      selAllBtn.type = 'button';
      selAllBtn.className = 'settings-metric-btn';
      selAllBtn.textContent = 'Select all';
      const clrAllBtn = document.createElement('button');
      clrAllBtn.type = 'button';
      clrAllBtn.className = 'settings-metric-btn';
      clrAllBtn.textContent = 'Clear all';
      btnRow.appendChild(selAllBtn);
      btnRow.appendChild(clrAllBtn);
      statusSection.appendChild(btnRow);

      const listWrap = document.createElement('div');
      listWrap.className = 'settings-metric-list';
      statusSection.appendChild(listWrap);

      function renderList(filter) {
        listWrap.innerHTML = '';
        const low = (filter ?? '').toLowerCase();
        const shown = low ? allMetrics.filter((m) => m.toLowerCase().includes(low)) : allMetrics;
        for (const m of shown) {
          const isVisible = settings.visibleMetrics === null || settings.visibleMetrics.has(m);
          const lbl = document.createElement('label');
          lbl.className = 'settings-checkbox-label';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = isVisible;
          cb.addEventListener('change', () => {
            if (settings.visibleMetrics === null) {
              settings.visibleMetrics = new Set(allMetrics);
            }
            if (cb.checked) {
              settings.visibleMetrics.add(m);
            } else {
              settings.visibleMetrics.delete(m);
            }
            persist();
            qcApi.tableApi.setVisibleMetrics(settings.visibleMetrics);
          });
          const span = document.createElement('span');
          span.textContent = m;
          lbl.appendChild(cb);
          lbl.appendChild(span);
          listWrap.appendChild(lbl);
        }
      }

      searchInput.addEventListener('input', () => renderList(searchInput.value));
      selAllBtn.addEventListener('click', () => {
        settings.visibleMetrics = null;
        persist();
        qcApi.tableApi.setVisibleMetrics(null);
        renderList(searchInput.value);
      });
      clrAllBtn.addEventListener('click', () => {
        settings.visibleMetrics = new Set();
        persist();
        qcApi.tableApi.setVisibleMetrics(settings.visibleMetrics);
        renderList(searchInput.value);
      });

      renderList();
    }

    qcApi.setRebuildMetrics(buildCheckboxes);
    buildCheckboxes();
    // statusSection appended to qcBox below

    // ── Layout: three columns — time settings | QC settings | session summary ───────
    const modalBody = document.createElement('div');
    modalBody.className = 'settings-modal-body';

    const timeCol = document.createElement('div');
    timeCol.className = 'settings-modal-col';
    timeCol.appendChild(sinceSection);
    modalBody.appendChild(timeCol);

    const qcCol2 = document.createElement('div');
    qcCol2.className = 'settings-modal-col';
    modalBody.appendChild(qcCol2);

    const qcBox = document.createElement('div');
    qcBox.className = 'settings-section-box';
    const qcBoxLabel = document.createElement('div');
    qcBoxLabel.className = 'settings-section-box-label';
    qcBoxLabel.textContent = 'QC settings';
    qcBox.appendChild(qcBoxLabel);
    qcBox.appendChild(grpSection);
    qcBox.appendChild(statusSection);
    qcCol2.appendChild(qcBox);

    // ── Summary row-by ────────────────────────────────────────────────────
    const sumCol = document.createElement('div');
    sumCol.className = 'settings-modal-col';
    modalBody.appendChild(sumCol);

    const sumBox = document.createElement('div');
    sumBox.className = 'settings-section-box';
    const sumBoxLabel = document.createElement('div');
    sumBoxLabel.className = 'settings-section-box-label';
    sumBoxLabel.textContent = 'Session summary settings';
    sumBox.appendChild(sumBoxLabel);
    const sumSection = document.createElement('div');
    sumSection.className = 'settings-section';
    const sumLabel = document.createElement('div');
    sumLabel.className = 'settings-section-label';
    sumLabel.textContent = 'Rows grouped by';
    sumSection.appendChild(sumLabel);
    for (const [val, text] of [['project', 'Project'], ['experimenter', 'Experimenter']]) {
      const lbl = document.createElement('label');
      lbl.className = 'settings-checkbox-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'platform-ov-sumby';
      radio.value = val;
      radio.checked = settings.summaryRowBy === val;
      radio.addEventListener('change', () => {
        if (radio.checked && val !== settings.summaryRowBy) {
          settings.summaryRowBy = val;
          persist();
          summaryApi.updateLabel();
          summaryApi.refresh();
        }
      });
      const span = document.createElement('span');
      span.textContent = text;
      lbl.appendChild(radio);
      lbl.appendChild(span);
      sumSection.appendChild(lbl);
    }
    sumBox.appendChild(sumSection);

    // ── Summary checkbox filters (instrument + experimenter) ───────────────
    // getValues is a function (() => array) so build() always reads the current
    // list even after it has been reassigned by async data loads.
    function buildSumCheckboxSection(labelText, getValues, settingKey, rebuildRef) {
      const section = document.createElement('div');
      section.className = 'settings-section';
      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'settings-section-label';
      sectionLabel.textContent = labelText;
      section.appendChild(sectionLabel);

      function build() {
        const allValues = getValues();
        while (section.children.length > 1) section.removeChild(section.lastChild);

        if (!allValues.length) {
          const note = document.createElement('p');
          note.className = 'settings-loading-note';
          note.textContent = 'Loading…';
          section.appendChild(note);
          return;
        }

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = `Search…`;
        searchInput.className = 'settings-metric-search';
        section.appendChild(searchInput);

        const btnRow = document.createElement('div');
        btnRow.className = 'settings-metric-btn-row';
        const selAllBtn = document.createElement('button');
        selAllBtn.type = 'button';
        selAllBtn.className = 'settings-metric-btn';
        selAllBtn.textContent = 'Select all';
        const clrAllBtn = document.createElement('button');
        clrAllBtn.type = 'button';
        clrAllBtn.className = 'settings-metric-btn';
        clrAllBtn.textContent = 'Clear all';
        btnRow.appendChild(selAllBtn);
        btnRow.appendChild(clrAllBtn);
        section.appendChild(btnRow);

        const listWrap = document.createElement('div');
        listWrap.className = 'settings-metric-list';
        section.appendChild(listWrap);

        function renderList(filter) {
          listWrap.innerHTML = '';
          const low = (filter ?? '').toLowerCase();
          const shown = low ? allValues.filter((v) => v.toLowerCase().includes(low)) : allValues;
          for (const v of shown) {
            const isChecked = settings[settingKey] === null || settings[settingKey].has(v);
            const lbl = document.createElement('label');
            lbl.className = 'settings-checkbox-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isChecked;
            cb.addEventListener('change', () => {
              if (settings[settingKey] === null) {
                settings[settingKey] = new Set(allValues);
              }
              if (cb.checked) {
                settings[settingKey].add(v);
              } else {
                settings[settingKey].delete(v);
              }
              persist();
              summaryApi.refresh();
            });
            const span = document.createElement('span');
            span.textContent = v;
            lbl.appendChild(cb);
            lbl.appendChild(span);
            listWrap.appendChild(lbl);
          }
        }

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        selAllBtn.addEventListener('click', () => {
          settings[settingKey] = null;
          persist();
          summaryApi.refresh();
          renderList(searchInput.value);
        });
        clrAllBtn.addEventListener('click', () => {
          settings[settingKey] = new Set();
          persist();
          summaryApi.refresh();
          renderList(searchInput.value);
        });

        renderList();
      }

      // Store rebuild reference so data-load can trigger it
      rebuildRef(build);
      build();
      return section;
    }

    summaryApi.setRebuildInstruments(null);
    summaryApi.setRebuildExperimenters(null);
    sumBox.appendChild(buildSumCheckboxSection('Filter by instrument', () => summaryApi.getInstruments(), 'summaryInstruments', (fn) => summaryApi.setRebuildInstruments(fn)));
    sumBox.appendChild(buildSumCheckboxSection('Filter by experimenter', () => summaryApi.getExperimenters(), 'summaryExperimenters', (fn) => summaryApi.setRebuildExperimenters(fn)));

    sumCol.appendChild(sumBox);
    content.appendChild(modalBody);

    document.body.appendChild(modal);
    modalOpen = true;

    setTimeout(() => {
      document.addEventListener('click', outsideClickHandler, true);
    }, 0);
  }

  function closeModal() {
    if (modal) {
      modal.remove();
      modal = null;
    }
    modalOpen = false;
    qcApi.setRebuildMetrics(null);
    summaryApi.setRebuildInstruments(null);
    summaryApi.setRebuildExperimenters(null);
    document.removeEventListener('click', outsideClickHandler, true);
  }

  function outsideClickHandler(e) {
    if (modal && !modal.contains(e.target) && e.target !== gearBtn) {
      closeModal();
    }
  }

  gearBtn.addEventListener('click', openSettingsModal);
}
