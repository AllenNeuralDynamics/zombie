/** Backend role names for the CRediT labels shown in the contribution editor. */
export const CREDIT_ROLE_ENUM = {
  Conceptualization: 'conceptualization',
  Methodology: 'methodology',
  Software: 'software',
  Validation: 'validation',
  'Formal analysis': 'formal-analysis',
  Investigation: 'investigation',
  Resources: 'resources',
  'Data curation': 'data-curation',
  'Writing – original draft': 'writing-original-draft',
  'Writing – review & editing': 'writing-review-editing',
  Visualization: 'visualization',
  Supervision: 'supervision',
  'Project Administration': 'project-administration',
  'Funding Acquisition': 'funding-acquisition',
};

export const CREDIT_ROLE_ENUM_REVERSE = Object.fromEntries(
  Object.entries(CREDIT_ROLE_ENUM).map(([label, role]) => [role, label]),
);
