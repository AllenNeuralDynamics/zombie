import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { isOrcidId, normalizeOrcidId } from './orcid-identity.js';
import { OrcidIdentityModal } from './orcid-identity-modal.js';
import { CREDIT_ROLES } from './credit-helpers.js';
import { CREDIT_ROLE_ENUM } from './credit-roles.js';
import { RoleTip } from './role-tooltip.js';
import {
  DEFAULT_AUTHOR_WORKFLOW_LEVELS,
  availableAuthorWorkflowLevels,
  workflowUiValueToStored,
  workflowLevelLabel,
  workflowValueToUiValue,
} from './author-workflow-levels.js';

function inputId(prefix, field) {
  return `${prefix}-${field}`;
}

export function AuthorProfileSection({
  idPrefix = 'author',
  name = '',
  orcid = '',
  email = '',
  authorLevel = null,
  startDate = '',
  endDate = '',
  affiliations = [],
  selectedAffiliationNames = [],
  onChange = () => {},
  onIdentityResolved = null,
  onAffiliationsChange = () => {},
  canEditName = true,
  showAuthorLevel = false,
}) {
  const [customAffiliation, setCustomAffiliation] = useState('');
  const [identityModalOpen, setIdentityModalOpen] = useState(false);
  const [identityModalMode, setIdentityModalMode] = useState('search');
  const [identityOrcid, setIdentityOrcid] = useState('');

  function toggleAffiliation(affiliationName) {
    onAffiliationsChange(selectedAffiliationNames.includes(affiliationName)
      ? selectedAffiliationNames.filter((current) => current !== affiliationName)
      : [...selectedAffiliationNames, affiliationName]);
  }

  function addAffiliation() {
    const trimmed = customAffiliation.trim();
    if (!trimmed) return;
    if (!selectedAffiliationNames.includes(trimmed)) {
      onAffiliationsChange([...selectedAffiliationNames, trimmed]);
    }
    setCustomAffiliation('');
  }

  const knownAffiliations = affiliations.map((affiliation) => affiliation.name);
  const customAffiliations = selectedAffiliationNames.filter(
    (affiliationName) => !knownAffiliations.includes(affiliationName),
  );
  const nameId = inputId(idPrefix, 'name');
  const orcidId = inputId(idPrefix, 'orcid');
  const emailId = inputId(idPrefix, 'email');
  const startId = inputId(idPrefix, 'join-date');
  const endId = inputId(idPrefix, 'leave-date');
  const levelId = inputId(idPrefix, 'author-level');

  return html`
    <section class="cv-author-form-section cv-author-profile-section">
      <h3 class="cv-subsection-heading">Profile</h3>
      <div class="cv-author-profile-grid">
        <div class="cv-wizard-field">
          <label class="cv-detail-label" for=${nameId}>Full Name *</label>
          <input id=${nameId} type="text" class="cv-wizard-input" value=${name}
                 disabled=${!canEditName}
                 onInput=${(event) => onChange('name', event.target.value)} />
        </div>
        <div class="cv-wizard-field">
          <label class="cv-detail-label" for=${orcidId}>ORCID iD</label>
          <div class="cv-orcid-row">
            <input id=${orcidId} type="text" class="cv-wizard-input"
                   placeholder="0000-0000-0000-0000" value=${orcid}
                   onInput=${(event) => {
                     const value = event.target.value;
                     onChange('orcid', value);
                     if (isOrcidId(value)) {
                       setIdentityOrcid(normalizeOrcidId(value));
                       setIdentityModalMode('resolve');
                       setIdentityModalOpen(true);
                     }
                   }} />
            <button type="button" class="btn-secondary"
                    disabled=${!name.trim()} onClick=${() => {
                      setIdentityModalMode('search');
                      setIdentityModalOpen(true);
                    }}>
              Search ORCID
            </button>
          </div>
        </div>
        <div class="cv-wizard-field">
          <label class="cv-detail-label" for=${emailId}>Email</label>
          <input id=${emailId} type="email" class="cv-wizard-input"
                 placeholder="name@example.org" value=${email}
                 onInput=${(event) => onChange('email', event.target.value)} />
        </div>
        ${showAuthorLevel && html`
          <div class="cv-wizard-field">
            <label class="cv-detail-label" for=${levelId}>Author level</label>
            <select id=${levelId} class="cv-author-level-select" value=${authorLevel || ''}
                    onChange=${(event) => onChange('authorLevel', event.target.value || null)}>
              <option value="">— none —</option>
              <option value="first">first</option>
              <option value="senior">senior</option>
            </select>
          </div>
        `}
        <div class="cv-wizard-field">
          <label class="cv-detail-label" for=${startId}>Join Date</label>
          <input id=${startId} type="date" class="cv-wizard-input" value=${startDate || ''}
                 onInput=${(event) => onChange('startDate', event.target.value || null)} />
        </div>
        <div class="cv-wizard-field">
          <label class="cv-detail-label" for=${endId}>End Date</label>
          <input id=${endId} type="date" class="cv-wizard-input" value=${endDate || ''}
                 onInput=${(event) => onChange('endDate', event.target.value || null)} />
        </div>
        <div class="cv-wizard-field cv-author-affiliations">
          <label class="cv-detail-label">Affiliations</label>
          ${affiliations.length > 0 && html`
            <div class="cv-wizard-aff-list">
              ${affiliations.map((affiliation) => html`
                <label key=${affiliation.id} class="cv-wizard-aff-item">
                  <input type="checkbox"
                         checked=${selectedAffiliationNames.includes(affiliation.name)}
                         onChange=${() => toggleAffiliation(affiliation.name)} />
                  <span>${affiliation.name}</span>
                </label>
              `)}
            </div>
          `}
          ${customAffiliations.map((affiliationName) => html`
            <div key=${affiliationName} class="cv-wizard-custom-aff-tag">
              <span>${affiliationName}</span>
              <button type="button" class="cv-x-btn"
                      aria-label=${'Remove ' + affiliationName}
                      onClick=${() => toggleAffiliation(affiliationName)}>×</button>
            </div>
          `)}
          <div class="cv-wizard-aff-add-row">
            <input type="text" class="cv-wizard-input"
                   placeholder="Add affiliation not listed above…"
                   value=${customAffiliation}
                   onInput=${(event) => setCustomAffiliation(event.target.value)}
                   onKeyDown=${(event) => event.key === 'Enter' && addAffiliation()} />
            <button type="button" class="btn-secondary" onClick=${addAffiliation}
                    disabled=${!customAffiliation.trim()}>Add</button>
          </div>
        </div>
      </div>
      ${identityModalOpen && html`
        <${OrcidIdentityModal}
          mode=${identityModalMode}
          name=${name}
          orcid=${identityOrcid}
          onResolve=${async (identity) => {
            if (onIdentityResolved) {
              await onIdentityResolved(identity);
            } else {
              if (canEditName && identity.name) onChange('name', identity.name);
              onChange('orcid', identity.orcid);
            }
          }}
          onCancel=${() => setIdentityModalOpen(false)}
        />
      `}
    </section>
  `;
}

export function AuthorRolesSection({
  roles = {},
  descriptions = {},
  workflowLevels = DEFAULT_AUTHOR_WORKFLOW_LEVELS,
  onRoleChange = () => {},
  onDescriptionChange = () => {},
}) {
  const levels = availableAuthorWorkflowLevels(workflowLevels);
  const activeRoles = CREDIT_ROLES.filter((role) => roles[role] && roles[role] !== 'None');

  function toggleRole(role) {
    const next = roles[role] && roles[role] !== 'None'
      ? 'None'
      : workflowValueToUiValue(levels.find((level) => level.value === 'equal')?.value || levels[0]?.value || 'equal', workflowLevels);
    onRoleChange(role, next);
  }

  return html`
    <section class="cv-author-form-section cv-author-roles-section">
      <h3 class="cv-subsection-heading">Roles & details</h3>
      <div class="cv-author-role-list">
        ${CREDIT_ROLES.map((role) => {
          const active = activeRoles.includes(role);
          const selected = workflowUiValueToStored(roles[role] || 'None', workflowLevels);
          const choices = levels.some((option) => option.value === selected)
            ? levels
            : [...levels, { value: selected, label: workflowLevelLabel(roles[role], workflowLevels), enabled: false }].filter((option) => option.value);
          const roleEnum = CREDIT_ROLE_ENUM[role];
          return html`
            <article key=${role}
                     class=${'cv-author-role-card' + (active ? ' cv-author-role-active' : '')}>
              <div class="cv-author-role-header">
                <label class="cv-author-role-check">
                  <input type="checkbox" checked=${active} onChange=${() => toggleRole(role)} />
                  <span><${RoleTip} name=${role} /></span>
                </label>
                ${active && levels.length > 0 && html`
                  <label class="cv-author-role-level-wrap">
                    <span class="cv-author-role-level-label">Level</span>
                    <select class="cv-wizard-role-level" aria-label=${role + ' level'}
                            value=${selected}
                            onChange=${(event) => onRoleChange(role, workflowValueToUiValue(event.target.value, workflowLevels))}>
                      ${choices.map((option) => html`
                        <option key=${option.value} value=${option.value} disabled=${option.enabled === false}>${option.label}</option>
                      `)}
                    </select>
                  </label>
                `}
              </div>
              ${active && html`
                <label class="cv-author-role-description">
                  <span class="cv-detail-label">Description</span>
                  <textarea class="cv-credit-desc-textarea" rows="2"
                            aria-label=${role + ' description'}
                            placeholder="Describe your specific contribution…"
                            value=${descriptions[roleEnum] || ''}
                            onInput=${(event) => onDescriptionChange(role, event.target.value)}></textarea>
                </label>
              `}
            </article>
          `;
        })}
      </div>
    </section>
  `;
}

export function AuthorSectionsSection({
  authorName = '',
  sections = [],
  sectionLevels = {},
  workflowLevels = DEFAULT_AUTHOR_WORKFLOW_LEVELS,
  onSectionChange = () => {},
}) {
  const options = availableAuthorWorkflowLevels(workflowLevels);
  return html`
    <section class="cv-author-form-section cv-author-sections-section">
      <h3 class="cv-subsection-heading">Sections</h3>
      ${sections.length === 0
        ? html`<p class="cv-placeholder">No paper sections are set up.</p>`
        : sections.map((section) => {
          const contribution = sectionLevels[section.title] || {};
          const level = workflowUiValueToStored(contribution.level || 'None', workflowLevels);
          const active = level !== '';
          const choices = options.some((option) => option.value === level)
            ? options
            : [...options, { value: level, label: workflowLevelLabel(contribution.level, workflowLevels), enabled: false }].filter((option) => option.value);
          return html`
            <div key=${section.id || section.title} class="cv-section-contrib-row">
              <label class="cv-section-contrib-check">
                <input type="checkbox"
                       aria-label=${authorName + ' contributed to ' + section.title}
                       checked=${active}
                       onChange=${() => onSectionChange(section.title, active ? 'none' : (options.find((option) => option.value === 'equal')?.value || options[0]?.value || 'equal'), contribution.description || '')} />
                <span class="cv-section-contrib-title">${section.title}</span>
              </label>
              ${active && options.length > 0 && html`
                <select class="cv-section-contrib-level" value=${level}
                        aria-label=${section.title + ' contribution level'}
                        onChange=${(event) => onSectionChange(section.title, event.target.value, contribution.description || '')}>
                  ${choices.map((option) => html`
                    <option key=${option.value} value=${option.value} disabled=${option.enabled === false}>${option.label}</option>
                  `)}
                </select>
              `}
              ${active && html`
                <input type="text" class="cv-section-contrib-desc"
                       placeholder="Description (optional)"
                       aria-label=${section.title + ' contribution description'}
                       value=${contribution.description || ''}
                       onInput=${(event) => onSectionChange(section.title, level || (options[0]?.value || 'equal'), event.target.value)} />
              `}
            </div>
          `;
        })}
    </section>
  `;
}

export function AuthorEditor({
  idPrefix,
  authorName,
  authorLevel,
  orcid,
  email,
  startDate,
  endDate,
  affiliations,
  selectedAffiliationNames,
  roles,
  descriptions,
  sections,
  sectionLevels,
  workflowLevels = DEFAULT_AUTHOR_WORKFLOW_LEVELS,
  canEditName = true,
  showAuthorLevel = false,
  onProfileChange,
  onIdentityResolved,
  onAffiliationsChange,
  onRoleChange,
  onDescriptionChange,
  onSectionChange,
}) {
  return html`
    <div class="cv-author-editor">
      <header class="cv-author-editor-header">
        <h3 class="cv-section-heading">Editing: <span class="cv-detail-name-badge">${authorName || '(unnamed)'}</span></h3>
      </header>
      <${AuthorProfileSection}
        idPrefix=${idPrefix}
        name=${authorName}
        orcid=${orcid}
        email=${email}
        authorLevel=${authorLevel}
        startDate=${startDate}
        endDate=${endDate}
        affiliations=${affiliations}
        selectedAffiliationNames=${selectedAffiliationNames}
        canEditName=${canEditName}
        showAuthorLevel=${showAuthorLevel}
        onChange=${onProfileChange}
        onIdentityResolved=${onIdentityResolved}
        onAffiliationsChange=${onAffiliationsChange}
      />
      <${AuthorRolesSection}
        roles=${roles}
        descriptions=${descriptions}
        workflowLevels=${workflowLevels}
        onRoleChange=${onRoleChange}
        onDescriptionChange=${onDescriptionChange}
      />
      <${AuthorSectionsSection}
        authorName=${authorName}
        sections=${sections}
        sectionLevels=${sectionLevels}
        workflowLevels=${workflowLevels}
        onSectionChange=${onSectionChange}
      />
    </div>
  `;
}
