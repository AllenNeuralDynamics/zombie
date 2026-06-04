/**
 * credit-helpers.js — Shared utilities for CRediT taxonomy helpers.
 *
 * This module contains helper functions and constants for working with
 * CRediT (Contributor Roles Taxonomy) roles and visualizations.
 */

/** All 14 CRediT taxonomy roles in canonical display order. */
export const CREDIT_ROLES = [
  'Conceptualization',
  'Methodology',
  'Software',
  'Validation',
  'Formal analysis',
  'Investigation',
  'Resources',
  'Data curation',
  'Writing – original draft',
  'Writing – review & editing',
  'Visualization',
  'Supervision',
  'Project Administration',
  'Funding Acquisition',
];

/** Full definitions and examples for each CRediT role, sourced from credit.niso.org (CC-BY 4.0). */
export const CREDIT_ROLE_DESCRIPTIONS = {
  'Conceptualization': {
    definition: 'Ideas; formulation or evolution of overarching research goals and aims.',
    examples: [
      'Identifying issues, questions or problems that warrant research.',
      'Developing research questions and hypotheses.',
      'Developing research frameworks, tools or experimental paradigms.',
      'Refining and adapting overarching research goals and aims.',
    ],
  },
  'Methodology': {
    definition: 'Development or design of methodology; creation of models.',
    examples: [
      'Developing quantitative and/or qualitative methodologies and frameworks.',
      'Defining search strategies and determining criteria for systematic literature reviews.',
      'Determining study design such as participant selection, materials, settings, data characteristics, data collection, measurement, and analysis techniques.',
    ],
  },
  'Software': {
    definition: 'Programming, software development; designing computer programs; implementation of the computer code and supporting algorithms; testing of existing code components.',
    examples: [
      'Designing, developing, testing, debugging, implementing, documenting, sharing and maintaining code.',
      'Developing, maintaining, managing and optimizing digital infrastructure, libraries, and databases.',
      'Conducting data extraction, data mining, and parsing content for qualitative or quantitative data collection and analysis.',
      'Ensuring interoperability, functionality, and scalability of code, databases, systems or platforms across different environments.',
    ],
  },
  'Validation': {
    definition: 'Verification, whether as a part of the activity or separate, of the overall replication/reproducibility of results/experiments and other research outputs.',
    examples: [
      'Ensuring the integrity, rigor and reliability of data, methods, results and resources through reviewing, verification, benchmarking, fact-checking, and replicating.',
      'Conducting pilot tests or preliminary studies to validate data collection instruments and protocols.',
      'Appraising studies included in systematic reviews and ensuring compliance with established review standards or reporting frameworks.',
      'Testing computational models or simulations against known outcomes for accuracy.',
    ],
  },
  'Formal analysis': {
    definition: 'Application of statistical, mathematical, computational, or other formal techniques to analyse or synthesize study data.',
    examples: [
      'Uncovering patterns and identifying relationships between variables and quantitative or qualitative datasets.',
      'Performing statistical tests to compare different groups within a study or evaluate change.',
      'Applying AI and machine learning models to predict outcomes.',
      'Developing computational simulations to model complex systems or phenomena.',
    ],
  },
  'Investigation': {
    definition: 'Conducting a research and investigation process, specifically performing the experiments, or data/evidence collection.',
    examples: [
      'Following or modifying methods to collect or generate data through quantitative and/or qualitative research approaches.',
      'Testing research hypotheses and documenting the research process.',
      'Searching and reviewing the literature, samples, data and other evidence.',
      'Reporting findings for further discussion, analysis, and exchange of ideas.',
    ],
  },
  'Resources': {
    definition: 'Provision of study materials, reagents, materials, patients, laboratory samples, animals, instrumentation, computing resources, or other analysis tools.',
    examples: [
      'Preparing, transporting or managing access to samples, artefacts, tools, equipment, documents, archives, and digital/physical infrastructure.',
      'Inventory management, safekeeping of samples and providing reports on availability and state of resources.',
      'Calibrating and maintaining instruments and equipment.',
      'Coordinating data storage solutions and computational resources.',
    ],
  },
  'Data curation': {
    definition: 'Management activities to annotate (produce metadata), scrub data and maintain research data (including software code, where it is necessary for interpreting the data itself) for initial use and later re-use.',
    examples: [
      'Conducting tasks like data processing, cleaning, cataloging, annotating, archiving, modeling, and retention.',
      'Integrating and aggregating data in diverse formats and from diverse sources.',
      'Managing and updating data descriptions and metadata, including maintaining version control and associated documentation.',
      'Developing or implementing data preservation strategies to ensure data remains findable, accessible, interoperable and reusable.',
    ],
  },
  'Writing \u2013 original draft': {
    definition: 'Preparation, creation and/or presentation of the published work, specifically writing the initial draft (including substantive translation).',
    examples: [
      'Creating the first and full version of an article.',
      'Drafting substantial original text within a section or across sections in an article.',
    ],
  },
  'Writing \u2013 review & editing': {
    definition: 'Preparation, creation and/or presentation of the published work by those from the original research group, specifically critical review, commentary or revision \u2013 including pre- or post-publication stages.',
    examples: [
      'Reviewing, copy-editing, refining language and providing comments and suggestions.',
      'Revising content based on feedback from internal and external reviewers.',
      'Providing review input of figures, tables, and supplementary materials.',
    ],
  },
  'Visualization': {
    definition: 'Preparation, creation and/or presentation of the published work, specifically visualization/data presentation.',
    examples: [
      'Using data to create charts, graphs or figures.',
      'Creating videos and other interactive media for communicating the findings.',
    ],
  },
  'Supervision': {
    definition: 'Oversight and leadership responsibility for the research activity planning and execution, including mentorship external to the core team.',
    examples: [
      'Overseeing researchers and other team members by setting milestones, tracking progress, ensuring quality of deliverables, and promoting adherence to ethics and integrity norms.',
      'Teaching, training, moderating and providing personal or professional advice to team members.',
      'Guiding teams in refining methods, interpreting results, and addressing interpersonal challenges.',
      'Collecting, logging, and reporting individual contributions to research.',
    ],
  },
  'Project Administration': {
    definition: 'Management and coordination responsibility for the research activity planning and execution.',
    examples: [
      'Monitoring and reporting progress, timelines, budgets, and compliance with ethical, governance, legal, health, safety, and other relevant standards.',
      'Recruiting participants needed for the research method.',
      'Organizing logistics for expeditions, fieldwork, equipment setup, and space allocation that support research operations.',
      'Managing correspondence with team members, journal editors, and various institutional departments.',
    ],
  },
  'Funding Acquisition': {
    definition: 'Acquisition of the financial support for the project leading to this publication.',
    examples: [
      'Identifying suitable funding sources, assessing eligibility and communicating requirements with the team members.',
      'Developing grant proposals and coordinating the submission process.',
      'Developing budgets and allocating funds to match project scope and funder expectations.',
    ],
  },
};

/**
 * Normalize a CRediT role string for comparison.
 * Converts to lowercase, collapses whitespace, and normalizes dashes.
 * @param {string} r
 * @returns {string}
 */
export function normalizeRole(r) {
  return r.toLowerCase().replace(/\s+/g, ' ').replace(/\u2014/g, '\u2013').trim();
}

/** Role → semantic group mapping. */
export const ROLE_GROUP = (() => {
  const m = {};
  for (const r of ['Conceptualization', 'Supervision', 'Project Administration', 'Funding Acquisition'])
    m[normalizeRole(r)] = 'leadership';
  for (const r of ['Methodology', 'Resources']) m[normalizeRole(r)] = 'methods';
  for (const r of ['Validation', 'Investigation', 'Data curation']) m[normalizeRole(r)] = 'data';
  for (const r of [
    'Formal analysis',
    'Software',
    'Writing – original draft',
    'Writing – review & editing',
    'Visualization',
  ])
    m[normalizeRole(r)] = 'analysis';
  return m;
})();

/** Hue [center, halfSpread] per group (degrees). */
export const GROUP_HUE = {
  leadership: [252, 32],
  methods: [41, 22],
  data: [165, 28],
  analysis: [340, 22],
};

/**
 * Simple deterministic string hash.
 * @param {string} s
 * @returns {number}
 */
export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

/**
 * Compute an HSL color for an author based on their majority CRediT group.
 *
 * @param {{ name: string, credit_levels?: Array<{role:string,level:string}> }} author
 * @param {Array} allAuthors — full list for co-contributor weighting
 * @returns {string} CSS hsl() color
 */
export function authorColor(author, allAuthors = []) {
  const counts = { leadership: 0, methods: 0, data: 0, analysis: 0 };
  const ownRoles = new Set();
  if (author.credit_levels) {
    for (const cl of author.credit_levels) {
      if (!cl.role) continue;
      const norm = normalizeRole(cl.role);
      ownRoles.add(norm);
      const grp = ROLE_GROUP[norm];
      if (grp) counts[grp]++;
    }
  }
  if (allAuthors.length > 0 && ownRoles.size > 0) {
    for (const other of allAuthors) {
      if (other.name === author.name || !other.credit_levels) continue;
      const shares = other.credit_levels.some((cl) => ownRoles.has(normalizeRole(cl.role)));
      if (!shares) continue;
      for (const cl of other.credit_levels) {
        if (!cl.role) continue;
        const grp = ROLE_GROUP[normalizeRole(cl.role)];
        if (grp) counts[grp] += 0.1;
      }
    }
  }
  const best = Math.max(counts.leadership, counts.methods, counts.data, counts.analysis);
  let group;
  if (best === 0) {
    group = ['leadership', 'methods', 'data', 'analysis'][hashStr(author.name) % 4];
  } else {
    const tied = Object.entries(counts)
      .filter(([, v]) => v === best)
      .map(([k]) => k);
    group = tied.length === 1 ? tied[0] : tied[hashStr(author.name) % tied.length];
  }
  const h1 = hashStr(author.name);
  const h2 = hashStr(author.name + '~');
  const [hCenter, hHalf] = GROUP_HUE[group];
  const hue = ((hCenter - hHalf + (h1 % (hHalf * 2 + 1))) + 360) % 360;
  const sat = 62 + (h2 % 18);
  const lgt = 40 + ((h1 >> 6) % 14);
  return `hsl(${hue},${sat}%,${lgt}%)`;
}

/**
 * Get 1-2 character initials from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Get last name from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getLastName(name) {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Get first name from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getFirstName(name) {
  const parts = name.trim().split(/\s+/);
  return parts[0];
}

/**
 * Detect dark mode from document theme.
 * @returns {boolean}
 */
export function isDarkMode() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme:dark)').matches);
}
