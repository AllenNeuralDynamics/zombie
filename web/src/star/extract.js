/**
 * star/extract.js — Build a Cell Press "STAR Methods" section from a DocDB record.
 *
 * Follows the official STAR Methods guide for authors (Cell Press, Apr 2026):
 * the section is FOUR standard headings plus a Key Resources Table (KRT):
 *
 *   1. Experimental model and study participant details
 *   2. Method details
 *   3. Quantification and statistical analysis
 *   4. Additional resources
 *   5. Key resources table (KRT)
 *
 * KRT rules we honour:
 *   - Three columns: Reagent or Resource | Source | Identifier.
 *   - ONLY the canonical category headings may be used — no custom headings.
 *     (Procedures, protocols and hardware are described in the narrative
 *     sections, not enumerated in the KRT; software/data/organisms/reagents are.)
 *   - Where an identifier is unavailable the cell must read "N/A".
 *   - One item per row; RRID / accession-style identifiers where available.
 *
 * AIND metadata is deeply nested and many relevant fields live inside lists, so
 * extraction combines a generic recursive `collectByType` walk (nothing missed
 * regardless of depth) with targeted reads of the prioritised top-level
 * sections: `subject`, `procedures`, `acquisition` (plus `data_description`,
 * `processing`, `instrument`).
 *
 * All functions here are PURE (record in → plain data out) for unit testing.
 *
 * Exports:
 *   collectByType(node, type)   — recursive collector, exported for tests.
 *   KRT_CATEGORIES              — canonical category ordering.
 *   extractStarMethods(record)  — full STAR-Methods representation.
 */

import { normalizeProtocolId } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Canonical KRT categories (Cell Press). We only populate the subset that AIND
// acquisition metadata can supply; empty categories are dropped at render time.
// ---------------------------------------------------------------------------

export const KRT_CATEGORIES = [
  'Experimental models: Organisms/strains',
  'Bacterial and virus strains',
  'Chemicals, peptides, and recombinant proteins',
  'Deposited data',
  'Software and algorithms',
  'Other',
];

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect every object with `object_type === type` anywhere in a
 * nested structure (walks both arrays and object values).
 *
 * @param {unknown} node
 * @param {string} type
 * @param {Array<Record<string, unknown>>} [out]
 * @returns {Array<Record<string, unknown>>}
 */
export function collectByType(node, type, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectByType(item, type, out);
  } else if (node && typeof node === 'object') {
    if (node.object_type === type) out.push(node);
    for (const key of Object.keys(node)) collectByType(node[key], type, out);
  }
  return out;
}

const isEmpty = (v) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (typeof v === 'string' && /^(unknown|n\/?a|none)$/i.test(v.trim())) ||
  (typeof v === 'string' && /\(v1v2 upgrade\)/i.test(v));

/** First non-empty value from the args. */
const firstOf = (...vals) => vals.find((v) => !isEmpty(v));

/** Join a value + unit into "value unit", dropping empties. */
const withUnit = (v, unit) => (isEmpty(v) ? null : isEmpty(unit) ? String(v) : `${v} ${unit}`);

/** Turn a protocol_id / DOI string into {text, href} (href only if resolvable). */
function protocolLink(raw) {
  if (isEmpty(raw)) return null;
  const href = normalizeProtocolId(raw);
  return href ? { text: String(raw), href } : { text: String(raw) };
}

/** Compute age in days between two ISO-ish datetime strings. */
function ageInDays(dob, at) {
  if (isEmpty(dob) || isEmpty(at)) return null;
  const a = new Date(dob);
  const b = new Date(at);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const days = Math.round((b - a) / 86400000);
  return days >= 0 ? days : null;
}

/** Names from a list of Person objects (or plain strings). */
const peopleNames = (arr) =>
  Array.isArray(arr) ? arr.map((p) => (p && typeof p === 'object' ? p.name : p)).filter(Boolean) : [];

// ---------------------------------------------------------------------------
// Key Resources Table
// ---------------------------------------------------------------------------

/** KRT row factory. identifier / source may be a string, {text, href}, or null. */
const row = (resource, source, identifier) => ({ resource, source, identifier });

function krtOrganisms(record) {
  const rows = [];
  const subj = record?.subject ?? {};
  const det = subj.subject_details ?? {};
  const subjectId = firstOf(subj.subject_id, record?.subject_id);
  const source = det.source?.name ?? null;

  if (det.object_type || subjectId) {
    const desc = [firstOf(det.object_type, 'Mouse subject')];
    if (!isEmpty(det.sex)) desc.push(det.sex);
    if (!isEmpty(det.genotype)) desc.push(det.genotype);
    if (det.strain?.name) desc.push(`strain ${det.strain.name}`);
    const idText = det.rrid
      ? String(det.rrid)
      : subjectId
        ? `Subject ID: ${subjectId}`
        : null;
    rows.push(row(desc.join('; '), source, idText ? { text: idText } : null));
  }
  return { title: 'Experimental models: Organisms/strains', rows };
}

function krtViral(record) {
  const rows = [];
  const seen = new Set();
  for (const vm of collectByType(record?.procedures, 'Viral material')) {
    const name = firstOf(vm.name);
    if (isEmpty(name)) continue;
    const key = `${name}|${vm.addgene_id ?? ''}|${vm.titer ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ids = [];
    if (!isEmpty(vm.addgene_id)) {
      const ag = String(vm.addgene_id);
      ids.push(/^\d+$/.test(ag) ? `RRID:Addgene_${ag}` : `Addgene ${ag}`);
    }
    const tars = vm.tars_identifiers;
    if (tars && !isEmpty(tars.virus_tars_id ?? tars.plasmid_tars_alias)) {
      ids.push(String(tars.virus_tars_id ?? tars.plasmid_tars_alias));
    }
    const titer = withUnit(vm.titer, vm.titer_unit);
    rows.push(row(name, titer ? `Titer: ${titer}` : null, ids.length ? { text: ids.join('; ') } : null));
  }
  return { title: 'Bacterial and virus strains', rows };
}

function krtChemicals(record) {
  const rows = [];
  const seen = new Set();
  for (const an of collectByType(record?.procedures, 'Anaesthetic')) {
    const t = firstOf(an.anaesthetic_type);
    if (isEmpty(t) || seen.has(t)) continue;
    seen.add(t);
    rows.push(row(t, 'Surgical anaesthesia', null));
  }
  return { title: 'Chemicals, peptides, and recombinant proteins', rows };
}

function krtDeposited(record) {
  const rows = [];
  const dd = record?.data_description ?? {};
  const inst = dd.institution?.name ?? null;
  const name = firstOf(record?.name, dd.name);
  if (name) {
    rows.push(row(`Raw data: ${name}`, inst, record?.location ? { text: String(record.location) } : null));
  }
  const oi = record?.other_identifiers;
  if (oi && typeof oi === 'object') {
    for (const [k, v] of Object.entries(oi)) {
      const vals = Array.isArray(v) ? v : [v];
      for (const item of vals) {
        if (isEmpty(item)) continue;
        rows.push(row(`${k} identifier`, k, { text: String(item) }));
      }
    }
  }
  return { title: 'Deposited data', rows };
}

function krtSoftware(record) {
  const rows = [];
  const seen = new Set();
  const codes = [
    ...collectByType(record?.acquisition, 'Code'),
    ...collectByType(record?.processing, 'Code'),
    ...collectByType(record?.instrument, 'Code'),
  ];
  for (const c of codes) {
    const url = firstOf(c.url);
    let name = firstOf(c.name);
    if ((isEmpty(name) || /^other$/i.test(name)) && url) {
      name = url.replace(/^https?:\/\//, '').replace(/^ghcr\.io\//, '').split(/[?#]/)[0];
    }
    if (isEmpty(name) && isEmpty(url)) continue;
    const ids = [];
    if (!isEmpty(c.version)) ids.push(`v${String(c.version).replace(/^v/i, '')}`);
    if (!isEmpty(c.commit_hash)) ids.push(String(c.commit_hash).slice(0, 10));
    if (!isEmpty(c.language)) ids.push(c.language);
    if (/^other$/i.test(String(name)) && isEmpty(url) && ids.length === 0) continue;
    const key = `${name}|${ids.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source =
      url && !/^other$/i.test(String(name)) && url !== name
        ? { text: url, href: /^https?:\/\//.test(url) ? url : undefined }
        : null;
    rows.push(row(name, source, ids.length ? { text: ids.join(', ') } : null));
  }
  return { title: 'Software and algorithms', rows };
}

function krtOther(record) {
  const rows = [];
  const acq = record?.acquisition ?? {};
  if (!isEmpty(acq.instrument_id)) {
    rows.push(row(`Instrument: ${acq.instrument_id}`, firstOf(acq.acquisition_type) ?? null, null));
  }
  const platform = acq.subject_details?.mouse_platform_name;
  if (!isEmpty(platform)) rows.push(row(`Mouse platform: ${platform}`, null, null));
  const devices = new Set();
  for (const ds of acq.data_streams ?? []) {
    for (const d of ds.active_devices ?? []) if (!isEmpty(d)) devices.add(String(d));
  }
  for (const d of devices) rows.push(row(`Device: ${d}`, null, null));
  return { title: 'Other', rows };
}

function buildKrt(record) {
  const byTitle = {
    'Experimental models: Organisms/strains': krtOrganisms(record),
    'Bacterial and virus strains': krtViral(record),
    'Chemicals, peptides, and recombinant proteins': krtChemicals(record),
    'Deposited data': krtDeposited(record),
    'Software and algorithms': krtSoftware(record),
    Other: krtOther(record),
  };
  // Emit in canonical order.
  return KRT_CATEGORIES.map((t) => byTitle[t]);
}

// ---------------------------------------------------------------------------
// 1. Experimental model and study participant details
// ---------------------------------------------------------------------------

function extractModel(record) {
  const facts = [];
  const push = (label, value) => {
    if (!isEmpty(value)) facts.push({ label, value: String(value) });
  };
  const subj = record?.subject ?? {};
  const det = subj.subject_details ?? {};
  const acqStart = record?.acquisition?.acquisition_start_time;

  push('Subject ID', firstOf(subj.subject_id, record?.subject_id));
  if (det.species?.name) {
    const reg = det.species.registry_identifier;
    push('Species', reg ? `${det.species.name} (${reg})` : det.species.name);
  }
  if (det.strain?.name) {
    const reg = det.strain.registry_identifier;
    push('Strain', reg ? `${det.strain.name} (${reg})` : det.strain.name);
  }
  push('Sex', det.sex);
  if (!isEmpty(det.date_of_birth)) {
    const age = ageInDays(det.date_of_birth, acqStart);
    push('Date of birth', `${det.date_of_birth}${age !== null ? ` (age ${age} days at acquisition)` : ''}`);
  }
  push('Genotype', det.genotype);
  const bi = det.breeding_info;
  if (bi && (bi.maternal_id || bi.paternal_id)) {
    const parents = [];
    if (bi.maternal_id) parents.push(`dam ${bi.maternal_id}`);
    if (bi.paternal_id) parents.push(`sire ${bi.paternal_id}`);
    push('Breeding', parents.join(', '));
  }
  const h = det.housing;
  if (h && (h.cage_id || h.room_id)) {
    const bits = [];
    if (h.cage_id) bits.push(`cage ${h.cage_id}`);
    if (h.room_id) bits.push(`room ${h.room_id}`);
    push('Housing', bits.join(', '));
  }
  push('Source', det.source?.name);

  // Ethics / regulatory oversight (committee IDs). Required disclosure per guide.
  const ethics = new Set();
  const acq = record?.acquisition ?? {};
  (Array.isArray(acq.ethics_review_id) ? acq.ethics_review_id : [acq.ethics_review_id]).forEach((e) => {
    if (!isEmpty(e)) ethics.add(String(e));
  });
  for (const sp of record?.procedures?.subject_procedures ?? []) {
    if (!isEmpty(sp.ethics_review_id)) ethics.add(String(sp.ethics_review_id));
  }
  if (ethics.size) push('Ethics review / IACUC protocol', [...ethics].join(', '));

  return facts;
}

// ---------------------------------------------------------------------------
// 2. Method details
// ---------------------------------------------------------------------------

function extractMethodDetails(record) {
  const procedures = [];
  const procs = record?.procedures ?? {};
  for (const sp of procs.subject_procedures ?? []) {
    const type = firstOf(sp.object_type, 'Procedure');
    const bits = [];
    if (!isEmpty(sp.start_date)) bits.push(sp.start_date);
    const an = sp.anaesthesia;
    if (an) {
      const dur = withUnit(an.duration, an.duration_unit);
      bits.push(
        `anaesthesia ${firstOf(an.anaesthetic_type) ?? ''}${an.level != null ? ` (level ${an.level}${dur ? `, ${dur}` : ''})` : ''}`.trim(),
      );
    }
    if (!isEmpty(sp.target_fraction_weight)) {
      bits.push(`target ${sp.target_fraction_weight}${sp.target_fraction_weight_unit === 'percent' ? '%' : ''} baseline weight`);
    }
    const nested = [];
    for (const np of sp.procedures ?? []) {
      const nt = firstOf(np.object_type, 'Procedure');
      const target = np.targeted_structure?.name ?? np.craniotomy_type ?? null;
      nested.push(target ? `${nt} (${target})` : nt);
    }
    if (nested.length) bits.push(nested.join('; '));
    procedures.push({ name: type, detail: bits.filter(Boolean).join(' — ') });
  }

  const acq = record?.acquisition ?? {};
  const streams = [];
  for (const ds of acq.data_streams ?? []) {
    streams.push({
      modalities: (ds.modalities ?? []).map((m) => firstOf(m.name, m.abbreviation)).filter(Boolean),
      start: firstOf(ds.stream_start_time),
      end: firstOf(ds.stream_end_time),
      notes: firstOf(ds.notes),
      configurations: (ds.configurations ?? [])
        .map((c) => {
          const t = firstOf(c.object_type);
          const d = firstOf(c.device_name);
          return t ? (d ? `${t} (${d})` : t) : null;
        })
        .filter(Boolean),
    });
  }

  return {
    instrument: firstOf(acq.instrument_id),
    acquisitionType: firstOf(acq.acquisition_type),
    platform: firstOf(acq.subject_details?.mouse_platform_name),
    procedures,
    streams,
    stimulusNames: (acq.stimulus_epochs ?? []).map((s) => firstOf(s.stimulus_name)).filter(Boolean),
    notes: firstOf(acq.notes),
  };
}

// ---------------------------------------------------------------------------
// 3. Quantification and statistical analysis
// ---------------------------------------------------------------------------

function extractQuantification(record) {
  const epochs = [];
  const acq = record?.acquisition ?? {};
  for (const se of acq.stimulus_epochs ?? []) {
    const pm = se.performance_metrics;
    if (!pm) continue;
    const metrics = [];
    if (pm.trials_total != null) metrics.push({ label: 'Trials (total)', value: pm.trials_total });
    if (pm.trials_finished != null) metrics.push({ label: 'Trials finished', value: pm.trials_finished });
    if (pm.trials_rewarded != null) metrics.push({ label: 'Trials rewarded', value: pm.trials_rewarded });
    const reward = withUnit(pm.reward_consumed_during_epoch, pm.reward_consumed_unit);
    if (reward) metrics.push({ label: 'Reward consumed', value: reward });
    if (metrics.length) epochs.push({ name: firstOf(se.stimulus_name, 'Stimulus epoch'), metrics });
  }
  const sd = acq.subject_details ?? {};
  const subject = [];
  const wp = withUnit(sd.animal_weight_prior, sd.weight_unit);
  const wpo = withUnit(sd.animal_weight_post, sd.weight_unit);
  const rew = withUnit(sd.reward_consumed_total, sd.reward_consumed_unit);
  if (wp) subject.push({ label: 'Weight prior', value: wp });
  if (wpo) subject.push({ label: 'Weight post', value: wpo });
  if (rew) subject.push({ label: 'Total reward consumed', value: rew });
  return { epochs, subject };
}

// ---------------------------------------------------------------------------
// 4. Additional resources (protocol download links, per the guide)
// ---------------------------------------------------------------------------

function extractAdditionalResources(record) {
  const seen = new Set();
  const out = [];
  const add = (description, raw) => {
    const link = protocolLink(raw);
    if (!link) return;
    const key = link.href ?? link.text;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ description, ...link });
  };
  const acq = record?.acquisition ?? {};
  (Array.isArray(acq.protocol_id) ? acq.protocol_id : [acq.protocol_id]).forEach((p) => add('Acquisition protocol', p));
  const procs = record?.procedures ?? {};
  for (const sp of procs.subject_procedures ?? []) {
    add(`${firstOf(sp.object_type, 'Procedure')} protocol`, sp.protocol_id);
    for (const np of sp.procedures ?? []) add(`${firstOf(np.object_type, 'Procedure')} protocol`, np.protocol_id);
  }
  for (const sp of procs.specimen_procedures ?? []) add(`${firstOf(sp.object_type, 'Specimen procedure')} protocol`, sp.protocol_id);
  return out;
}

// ---------------------------------------------------------------------------
// Header summary (page context; not itself a STAR heading)
// ---------------------------------------------------------------------------

function extractSummary(record) {
  const dd = record?.data_description ?? {};
  const acq = record?.acquisition ?? {};
  const modalities = (dd.modalities ?? []).map((m) => firstOf(m.name, m.abbreviation)).filter(Boolean);
  return {
    name: firstOf(record?.name, dd.name),
    subjectId: firstOf(record?.subject?.subject_id, dd.subject_id),
    project: firstOf(dd.project_name),
    institution: dd.institution?.name ?? null,
    modalities,
    acquisitionType: firstOf(acq.acquisition_type),
    instrument: firstOf(acq.instrument_id),
    start: firstOf(acq.acquisition_start_time),
    end: firstOf(acq.acquisition_end_time),
    experimenters: peopleNames(acq.experimenters),
    investigators: peopleNames(dd.investigators),
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Extract a full STAR-Methods representation of a DocDB record.
 *
 * @param {Record<string, unknown>} record
 * @returns {{
 *   summary: object,
 *   model: Array<{label:string, value:string}>,
 *   methodDetails: object,
 *   quantification: object,
 *   additionalResources: Array<object>,
 *   krt: Array<{title:string, rows:Array}>,
 * }}
 */
export function extractStarMethods(record) {
  return {
    summary: extractSummary(record),
    model: extractModel(record),
    methodDetails: extractMethodDetails(record),
    quantification: extractQuantification(record),
    additionalResources: extractAdditionalResources(record),
    krt: buildKrt(record),
  };
}
