import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { CREDIT_ROLES, LEVEL_LABELS, enabledLevels } from './credit-helpers.js';
import { CREDIT_ROLE_ENUM } from './credit-roles.js';
import { RoleTip } from './role-tooltip.js';

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
  onAffiliationsChange = () => {},
  canEditName = true,
  showAuthorLevel = false,
}) {
  const [customAffiliation, setCustomAffiliation] = useState('');
  const [orcidResults, setOrcidResults] = useState([]);
  const [searching, setSearching] = useState(false);

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

  async function searchOrcid() {
    if (!name.trim()) return;
    setSearching(true);
    try {
      const parts = name.trim().split(/\s+/);
      const familyName = parts[parts.length - 1];
      const givenNames = parts.slice(0, -1).join('+');
      const query = givenNames
        ? `family-name:${encodeURIComponent(familyName)}+AND+given-names:${encodeURIComponent(givenNames)}`
        : `family-name:${encodeURIComponent(familyName)}`;
      const response = await fetch(`https://pub.orcid.org/v3.0/search/?q=${query}&rows=5`, {
        headers: { Accept: 'application/vnd.orcid+json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      setOrcidResults((data.result || [])
        .map((result) => result['orcid-identifier']?.path)
        .filter(Boolean));
    } catch (_) {
      setOrcidResults([]);
    } finally {
      setSearching(false);
    }
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
                   onInput=${(event) => onChange('orcid', event.target.value)} />
            <button type="button" class="btn-secondary"
                    disabled=${searching || !name.trim()} onClick=${searchOrcid}>
              ${searching ? '…' : 'Search'}
            </button>
          </div>
          ${orcidResults.length > 0 && html`
            <div class="cv-wizard-orcid-results">
              ${orcidResults.map((result) => html`
                <span key=${result} class="cv-orcid-result-row">
                  <button type="button" class="cv-chip"
                          onClick=${() => { onChange('orcid', result); setOrcidResults([]); }}>
                    ${result}
                  </button>
                  <a href=${`https://orcid.org/${result}`} target="_blank"
                     rel="noopener noreferrer" class="cv-orcid-verify-link">verify ↗</a>
                </span>
              `)}
            </div>
          `}
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
    </section>
  `;
}

export function AuthorRolesSection({
  roles = {},
  descriptions = {},
  allowLead = true,
  allowLevels = true,
  onRoleChange = () => {},
  onDescriptionChange = () => {},
}) {
  const levels = enabledLevels({ allowLevels, allowLead });
  const activeRoles = CREDIT_ROLES.filter((role) => roles[role] && roles[role] !== 'None');

  function toggleRole(role) {
    onRoleChange(role, roles[role] && roles[role] !== 'None' ? 'None' : 'Equal');
  }

  return html`
    <section class="cv-author-form-section cv-author-roles-section">
      <h3 class="cv-subsection-heading">Roles & details</h3>
      <div class="cv-author-role-list">
        ${CREDIT_ROLES.map((role) => {
          const active = activeRoles.includes(role);
          const level = String(roles[role] || 'None').toLowerCase();
          const roleEnum = CREDIT_ROLE_ENUM[role];
          return html`
            <article key=${role}
                     class=${'cv-author-role-card' + (active ? ' cv-author-role-active' : '')}>
              <div class="cv-author-role-header">
                <label class="cv-author-role-check">
                  <input type="checkbox" checked=${active} onChange=${() => toggleRole(role)} />
                  <span><${RoleTip} name=${role} /></span>
                </label>
                ${active && allowLevels && html`
                  <label class="cv-author-role-level-wrap">
                    <span class="cv-author-role-level-label">Level</span>
                    <select class="cv-wizard-role-level" aria-label=${role + ' level'}
                            value=${level}
                            onChange=${(event) => onRoleChange(role, event.target.value)}>
                      ${levels.map((option) => html`
                        <option key=${option} value=${option}>${LEVEL_LABELS[option]}</option>
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
  allowLead = true,
  allowLevels = true,
  onSectionChange = () => {},
}) {
  const options = enabledLevels({ allowLevels, allowLead });
  return html`
    <section class="cv-author-form-section cv-author-sections-section">
      <h3 class="cv-subsection-heading">Sections</h3>
      ${sections.length === 0
        ? html`<p class="cv-placeholder">No paper sections are set up.</p>`
        : sections.map((section) => {
          const contribution = sectionLevels[section.title] || {};
          const level = String(contribution.level || 'None').toLowerCase();
          const active = level !== 'none';
          return html`
            <div key=${section.id || section.title} class="cv-section-contrib-row">
              <label class="cv-section-contrib-check">
                <input type="checkbox"
                       aria-label=${authorName + ' contributed to ' + section.title}
                       checked=${active}
                       onChange=${() => onSectionChange(section.title, active ? 'none' : 'equal', contribution.description || '')} />
                <span class="cv-section-contrib-title">${section.title}</span>
              </label>
              ${active && allowLevels && html`
                <select class="cv-section-contrib-level" value=${level}
                        aria-label=${section.title + ' contribution level'}
                        onChange=${(event) => onSectionChange(section.title, event.target.value, contribution.description || '')}>
                  ${options.map((option) => html`
                    <option key=${option} value=${option}>${LEVEL_LABELS[option]}</option>
                  `)}
                </select>
              `}
              ${active && html`
                <input type="text" class="cv-section-contrib-desc"
                       placeholder="Description (optional)"
                       aria-label=${section.title + ' contribution description'}
                       value=${contribution.description || ''}
                       onInput=${(event) => onSectionChange(section.title, level || 'equal', event.target.value)} />
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
  allowLead,
  allowLevels,
  canEditName = true,
  showAuthorLevel = false,
  onProfileChange,
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
        onAffiliationsChange=${onAffiliationsChange}
      />
      <${AuthorRolesSection}
        roles=${roles}
        descriptions=${descriptions}
        allowLead=${allowLead}
        allowLevels=${allowLevels}
        onRoleChange=${onRoleChange}
        onDescriptionChange=${onDescriptionChange}
      />
      <${AuthorSectionsSection}
        authorName=${authorName}
        sections=${sections}
        sectionLevels=${sectionLevels}
        allowLead=${allowLead}
        allowLevels=${allowLevels}
        onSectionChange=${onSectionChange}
      />
    </div>
  `;
}
