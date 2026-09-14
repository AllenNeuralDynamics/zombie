const METRIC_SELECTOR = '.qc-metric-card, .qc-metrics-table-row';
const ACTIVE_METRIC_CLASS = 'qc-metric-keyboard-active';

let activeCleanup = null;

function metricForTarget(target) {
  return target instanceof Element ? target.closest(METRIC_SELECTOR) : null;
}

function metricControls(metric) {
  return [...metric.querySelectorAll('select, input, textarea, button')]
    .filter(control => !control.disabled && !control.hidden && control.type !== 'hidden');
}

function metricValueTarget(metric) {
  const value = metric.querySelector('.metric-value');
  if (!value) return metric;

  const selector = 'select, input, textarea, button, [contenteditable="true"], [tabindex]';
  const candidates = value.matches(selector) ? [value] : [...value.querySelectorAll(selector)];
  const target = candidates.find(candidate =>
    !candidate.disabled && !candidate.hidden && candidate.type !== 'hidden');
  if (target) return target;

  // Some read-only/custom value components are not native controls. Make the
  // value area focusable so W/S still lands on the value component.
  value.tabIndex = -1;
  return value;
}

function focusElement(element) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function scrollMetricIntoView(metric) {
  if (typeof metric.scrollIntoView !== 'function') return;
  try {
    metric.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {
    metric.scrollIntoView();
  }
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  return target.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"])');
}

function isDocumentAnchor(target, root, ownerDocument) {
  return target === root || target === ownerDocument.body || target === ownerDocument.documentElement;
}

/**
 * Add keyboard navigation to one QC view.
 *
 * W/S moves between rendered metrics. A metric card/row is made programmatically
 * focusable by renderMetrics/renderMetricsTable so the browser can continue its
 * normal focus order from there. Tab is trapped only between enabled controls in
 * the active metric; all other keys retain their native browser behavior.
 */
export function installQcKeyboardControl(root, getMetricRoot = () => root) {
  activeCleanup?.();

  const ownerDocument = root.ownerDocument ?? document;
  const handledEvents = new WeakSet();
  let activeMetric = null;

  const getMetrics = () => [...getMetricRoot().querySelectorAll(METRIC_SELECTOR)];

  const setActiveMetric = (metric, { focus = false } = {}) => {
    const metrics = getMetrics();
    activeMetric = metrics.includes(metric) ? metric : null;
    for (const candidate of metrics) {
      candidate.classList.toggle(ACTIVE_METRIC_CLASS, candidate === activeMetric);
    }
    if (activeMetric && focus) {
      scrollMetricIntoView(activeMetric);
      focusElement(focus === 'value' ? metricValueTarget(activeMetric) : activeMetric);
    }
  };

  const setInitialMetric = (targetMetric = null) => {
    const metrics = getMetrics();
    if (!metrics.length) return null;
    if (targetMetric && metrics.includes(targetMetric)) {
      setActiveMetric(targetMetric);
    } else if (!activeMetric || !metrics.includes(activeMetric)) {
      setActiveMetric(metrics[0]);
    }
    return activeMetric;
  };

  const openAdjacentAccordion = (metric, direction) => {
    const details = metric?.closest('.qc-accordion details');
    const accordion = details?.closest('.qc-accordion');
    if (!details || !accordion) return null;

    const groups = [...accordion.children].filter(child => child.matches('details'));
    const groupIndex = groups.indexOf(details);
    const nextGroup = groups[groupIndex + direction];
    if (!nextGroup) return null;

    accordion.openAccordion?.(nextGroup);
    const nextMetrics = getMetrics().filter(candidate => candidate.closest('.qc-accordion details') === nextGroup);
    return direction > 0 ? nextMetrics[0] : nextMetrics.at(-1);
  };

  const moveMetric = (direction) => {
    const metrics = getMetrics();
    if (!metrics.length) return;

    const current = setInitialMetric();
    const currentIndex = metrics.indexOf(current);
    const next = metrics[currentIndex + direction] ?? openAdjacentAccordion(current, direction) ?? current;
    setActiveMetric(next, { focus: 'value' });
  };

  const cycleMetricControls = (event, metric) => {
    if (!metric) return false;
    const controls = metricControls(metric);
    if (!controls.length) return false;

    const target = event.target;
    const targetIsMetric = target === metric;
    const targetIsControl = controls.includes(target);
    const targetIsValueArea = target === metric.querySelector('.metric-value');
    const targetIsAnchor = isDocumentAnchor(target, root, ownerDocument);
    if (!targetIsMetric && !targetIsControl && !targetIsValueArea && !targetIsAnchor) return false;

    // With one control, enter it from the metric card, then let Tab leave it.
    // With multiple controls, cycle in both directions as requested.
    if (controls.length === 1) {
      if (targetIsMetric || targetIsValueArea || targetIsAnchor) {
        if (event.shiftKey) return false;
        event.preventDefault();
        focusElement(controls[0]);
        return true;
      }
      return false;
    }

    const currentIndex = controls.indexOf(target);
    const nextIndex = currentIndex < 0
      ? (event.shiftKey ? controls.length - 1 : 0)
      : (currentIndex + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    event.preventDefault();
    focusElement(controls[nextIndex]);
    return true;
  };

  const handleKeydown = (event) => {
    if (handledEvents.has(event)) return;

    const target = event.target;
    const inView = root.contains(target) ||
      (root.isConnected && (target === ownerDocument.body || target === ownerDocument.documentElement));
    if (!inView) return;
    handledEvents.add(event);

    root.classList.add('qc-keyboard-control');
    const targetMetric = metricForTarget(target);
    setInitialMetric(targetMetric);

    const key = String(event.key ?? '').toLowerCase();
    if ((key === 'w' || key === 's') && !isTextEntryTarget(target)) {
      moveMetric(key === 'w' ? -1 : 1);
      event.preventDefault();
      return;
    }

    // Arrow and Enter intentionally do not come through this branch. Native
    // select behavior must open/select/apply exactly as it normally does.
    if (event.key === 'Tab') {
      cycleMetricControls(event, targetMetric ?? activeMetric);
    }
  };

  root.addEventListener('keydown', handleKeydown);
  ownerDocument.addEventListener('keydown', handleKeydown);

  const cleanup = () => {
    root.removeEventListener('keydown', handleKeydown);
    ownerDocument.removeEventListener('keydown', handleKeydown);
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}
