/**
 * contributions-entry.js — Landing page for the Contributions section.
 *
 * Provides a simple input to enter a DOI / project name and navigate to
 * the view or edit page.
 */

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="contributions-landing">
      <h1 class="contributions-landing-title">CRediT Author Contributions</h1>
      <p class="contributions-landing-desc">
        Enter a DOI or project name to view or edit the contribution matrix.
      </p>
      <div class="contributions-landing-form">
        <input id="cl-doi-input" type="text" class="contributions-landing-input"
               placeholder="e.g. 10.1234/example.2024 or my-project-name" />
        <div class="contributions-landing-btns">
          <button id="cl-view-btn" class="btn-primary">View</button>
          <button id="cl-edit-btn" class="btn-secondary">Edit</button>
        </div>
      </div>
    </div>
  `;

  const input = app.querySelector('#cl-doi-input');
  const viewBtn = app.querySelector('#cl-view-btn');
  const editBtn = app.querySelector('#cl-edit-btn');

  function navigate(page) {
    const doi = input.value.trim();
    if (!doi) { input.focus(); return; }
    window.location.href = `/contributions/${page}?doi=${encodeURIComponent(doi)}`;
  }

  viewBtn.addEventListener('click', () => navigate('view'));
  editBtn.addEventListener('click', () => navigate('edit'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate('view');
  });
}

init();
