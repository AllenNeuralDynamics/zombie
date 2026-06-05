/**
 * demo-page.js — Compact publication cards with expandable contribution previews.
 *
 * Each card shows a publication title, journal, year, and a compact author byline.
 * Clicking "Explore" expands the card to show the full createPreview() widget,
 * pushing sibling cards out of the way.
 *
 * A settings gear in the top-right toggles between name list and author image bubbles.
 */

import { html, render } from 'htm/preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { createPreview } from './preview.js';
import { getInitials, hashStr } from './credit-helpers.js';

// ─── Author image map ───────────────────────────────────────────────────────

const AUTHOR_IMAGES = {
  'Yiliu Wang': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594aa5860e37f46131e07_Yiliu_Wang_SQUARE.jpeg',
  'Christof Koch': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594c04cfa36e91a0f3b7a_christof_koch_web-new.jpeg',
  'Uygar Sümbül': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594a7f3ca51bdc36a0335_uygar_sumbul_web-new.jpeg',
  'Julie A. Harris': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594df0dff40ba53dfe07e_Julie_Harris_SQUARE.jpeg',
  'Michael Kunst': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59491f7a4d157a1794ce9_Michael_Kunst-2-Allen-Institute-Headshot-Square-Large.jpeg',
  'Shenqin Yao': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c5951c7c76f9c375e58490_shenqin_yao_web-new.jpeg',
  'Nicholas Lusk': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59503cbfee7a71b785970_Nicholas_Lusk-Allen-Institute-Headshot-Square-Large.jpeg',
  'Lydia Ng': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594f2f3156a871e92d00e_lydia_ng_web-new.jpeg',
  'Hongkui Zeng': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59477de4bd8ad942059fd_Hongkui_Zeng_SQUARE.jpeg',
  'Bosiljka Tasic': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59464da3aeedae8f9c400_Bosiljka_Tasic-Allen-Institute-Headshot-Square-Large.jpeg',
  'Rebecca Hodge': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59511de4bd8ad94207e49_rebeccahodge-web.jpeg',
  'Xiaoyin Chen': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594a9c1cfefe8f4eb0072_Xiaoyin_Chen_SQUARE.jpeg',
  'Ryan V. Raut': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c5949d914e5244e91bf3fa_ryan_raut_web-1.jpeg',
  'Rong Guo': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c5949c18dfca61d91acf2e_rong_guo_temp-1.jpeg',
  'Ravi Bhowmik': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c59510edc0f06f369059a4_Ravi_Bhowmik_SQ.jpeg',
  'Kara Ronellenfitch': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594e2417f0bbbadc6b89c_kara_ronellenfitch-web.jpeg',
  'John K. Mich': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594dd881d0cfefba78244_johnmich-e1706891409181.jpeg',
  'Bryan B. Gore': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594ba532157c4e01de12a_Bryan_Gore_headshot.jpeg',
  'Ed S. Lein': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594c8c55912c07c195826_ed_lein-web.jpeg',
  'Jack Waters': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594d2b47a10e6316afb63_jackwaters.jpeg',
  'Kevin T. Takasaki': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c594e9e996354783388df2_kevin_takasaki-1.jpeg',
  'Meagan A. Quinlan': 'https://cdn.prod.website-files.com/69a0ca6ef8ecfacbc1d10e9b/69c5949035f840d7ef75e051_Meagan_Quinlan-Allen-Institute-Headshot-Square-Large.jpeg',
};

// ─── Publication data ───────────────────────────────────────────────────────

const PUBLICATIONS = [
  {
    title: 'Evidence from spatial transcriptomics for the mosaic hypothesis and pure cell types in the cortex',
    journal: 'Cell Reports',
    year: 2025,
    doi: '10.1016/j.celrep.2025.116363',
    authors: [
      { name: 'Yiliu Wang' },
      { name: 'Christof Koch' },
      { name: 'Uygar Sümbül' },
    ],
  },
  {
    title: 'Spontaneous pathology in PS19 tauopathy mice progresses via brain networks',
    journal: 'Neurobiology of Disease',
    year: 2025,
    doi: '10.1016/j.nbd.2025.107072',
    authors: [
      { name: 'Denise M.O. Ramirez' },
      { name: 'Jennifer D. Whitesell' },
      { name: 'Nikhil Bhagwat' },
      { name: 'Talitha L. Thomas' },
      { name: 'Apoorva D. Ajay' },
      { name: 'Ariana Nawaby' },
      { name: 'Benoît Delatour' },
      { name: 'Sylvie Bay' },
      { name: 'Pierre LaFaye' },
      { name: 'Julie A. Harris' },
      { name: 'Julian P. Meeks' },
      { name: 'Marc I. Diamond' },
    ],
  },
  {
    title: 'Data-driven fine-grained region discovery in the mouse brain with transformers',
    journal: 'Nature Communications',
    year: 2025,
    doi: '10.1038/s41467-025-64259-4',
    authors: [
      { name: 'Alex J. Lee' },
      { name: 'Alma Dubuc' },
      { name: 'Michael Kunst' },
      { name: 'Shenqin Yao' },
      { name: 'Nicholas Lusk' },
      { name: 'Lydia Ng' },
      { name: 'Hongkui Zeng' },
      { name: 'Bosiljka Tasic' },
      { name: 'Reza Abbasi-Asl' },
    ],
  },
  {
    title: 'What makes the human brain special: from cellular function to clinical translation',
    journal: 'Journal of Neurophysiology',
    year: 2025,
    doi: '10.1152/jn.00120.2025',
    authors: [
      { name: 'Karen M. J. van Loo' },
      { name: 'Aniella Bak' },
      { name: 'Rebecca Hodge' },
      { name: 'Francesco Bedogni' },
      { name: 'Julian S. B. Ramirez' },
      { name: 'Samuel N. Emerson' },
      { name: 'Anke Höllig' },
      { name: 'Huibert D. Mansvelder' },
      { name: 'Natalia A. Goriounova' },
      { name: 'Jan-Marino Ramirez' },
      { name: 'Henner Koch' },
    ],
  },
  {
    title: 'The xIV-LDDMM toolkit of image-varifold based technologies for mapping 3D images and spatial-omics across scales',
    journal: 'Communications Biology',
    year: 2025,
    doi: '10.1038/s42003-025-08800-7',
    authors: [
      { name: 'Kaitlin M. Stouffer' },
      { name: 'Xiaoyin Chen' },
      { name: 'Hongkui Zeng' },
      { name: 'Benjamin Charlier' },
      { name: 'Laurent Younes' },
      { name: 'Alain Trouvé' },
      { name: 'Michael I. Miller' },
    ],
  },
  {
    title: 'Arousal as a universal embedding for spatiotemporal brain dynamics',
    journal: 'Nature',
    year: 2025,
    doi: '10.1038/s41586-025-09544-4',
    authors: [
      { name: 'Ryan V. Raut' },
      { name: 'Zachary P. Rosenthal' },
      { name: 'Xiaodan Wang' },
      { name: 'Hanyang Miao' },
      { name: 'Zhanqi Zhang' },
      { name: 'Jin-Moo Lee' },
      { name: 'Marcus E. Raichle' },
      { name: 'Adam Q. Bauer' },
      { name: 'Steven L. Brunton' },
      { name: 'Bingni W. Brunton' },
      { name: 'J. Nathan Kutz' },
    ],
  },
  {
    title: 'AAV delivery of full-length SYNGAP1 rescues epileptic and behavioral phenotypes in a mouse model of SYNGAP1-related disorders',
    journal: 'Molecular Therapy',
    year: 2025,
    doi: '10.1016/j.ymthe.2025.09.040',
    authors: [
      { name: 'Meagan A. Quinlan' },
      { name: 'Rong Guo' },
      { name: 'Andrew G. Clark' },
      { name: 'Emily M. Luber' },
      { name: 'Robert J. Christian' },
      { name: 'Refugio A. Martinez' },
      { name: 'Erin L. Groce' },
      { name: 'Jiatai Liu' },
      { name: 'Yemeserach M. Bishaw' },
      { name: 'Ravi Bhowmik' },
      { name: 'Elizabeth Liang' },
      { name: 'Melissa Reding' },
      { name: 'Kara Ronellenfitch' },
      { name: 'Vonn Wright' },
      { name: 'Kathryn M. Gudsnuk' },
      { name: 'Jennifer M. Leedy' },
      { name: 'John K. Mich' },
      { name: 'Bryan B. Gore' },
      { name: 'Tanya L. Daigle' },
      { name: 'Manuel E. Lopez' },
      { name: 'Ed S. Lein' },
      { name: 'Justin K. Ichida' },
      { name: 'Boaz P. Levi' },
    ],
  },
  {
    title: 'Imaging high-frequency voltage dynamics in multiple neuron classes of behaving mammals',
    journal: 'Cell',
    year: 2025,
    doi: '10.1016/j.cell.2025.08.010',
    authors: [
      { name: 'Simon Haziza' },
      { name: 'Radosław Chrapkiewicz' },
      { name: 'Yanping Zhang' },
      { name: 'Vasily Kruzhilin' },
      { name: 'Jane Li' },
      { name: 'Jizhou Li' },
      { name: 'Geoffroy Delamare' },
      { name: 'Rachel Swanson' },
      { name: 'György Buzsáki' },
      { name: 'Madhuvanthi Kannan' },
      { name: 'Ganesh Vasan' },
      { name: 'Michael Z. Lin' },
      { name: 'Hongkui Zeng' },
      { name: 'Tanya L. Daigle' },
      { name: 'Mark J. Schnitzer' },
    ],
  },
  {
    title: 'Impaired capillary-venous drainage contributes to gliosis and demyelination in mouse white matter during aging',
    journal: 'Nature Neuroscience',
    year: 2025,
    doi: '10.1038/s41593-025-02023-z',
    authors: [
      { name: 'Stefan Stamenkovic' },
      { name: 'Franca Schmid' },
      { name: 'Gokce Gurler' },
      { name: 'Farzaneh Abolmaali' },
      { name: 'Nicolas A. Weitermann' },
      { name: 'Kevin T. Takasaki' },
      { name: 'Stephanie K. Bonney' },
      { name: 'Maria J. Sosa' },
      { name: 'Hannah C. Bennett' },
      { name: 'Yongsoo Kim' },
      { name: 'Jack Waters' },
      { name: 'Andy Y. Shih' },
    ],
  },
];

// ─── Shuffle helper (Fisher-Yates) ──────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Compact author byline (name list mode) ────────────────────────────────

function AuthorByline({ authors }) {
  return html`
    <span class="demo-byline">
      ${authors.map((a, i) => html`
        <span class="demo-author-name" key=${a.name}>${a.name}</span>${i < authors.length - 1 ? ', ' : ''}
      `)}
    </span>
  `;
}

// ─── Author image bubbles mode ──────────────────────────────────────────────

const INITIALS_GREYS = [
  '#6b7280', '#78716c', '#71717a', '#737373', '#64748b',
  '#57534e', '#52525b', '#525252', '#475569', '#44403c',
];

function initialsColor(name) {
  return INITIALS_GREYS[hashStr(name) % INITIALS_GREYS.length];
}

const BUBBLE_SIZE = 36;
const BOUNCE_H = 120;

function AuthorBubbles({ authors, bouncing }) {
  const shuffled = useMemo(() => shuffle(authors), []);
  const MAX_BUBBLES = 12;
  const shown = shuffled.slice(0, MAX_BUBBLES);
  const rest = shuffled.length - MAX_BUBBLES;
  const total = shown.length + (rest > 0 ? 1 : 0);

  const containerRef = useRef(null);
  const elRefs = useRef([]);
  const rafRef = useRef(null);
  const physicsRef = useRef(null);

  useEffect(() => {
    if (!bouncing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      physicsRef.current = null;
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Initialize physics state once (or reuse if already running)
    if (!physicsRef.current) {
      const W = container.offsetWidth || 300;
      physicsRef.current = elRefs.current.slice(0, total).map((_, i) => {
        // Spread initial positions in a grid so they don't all start at 0,0
        const cols = Math.max(1, Math.floor(W / (BUBBLE_SIZE + 8)));
        const col = i % cols;
        const row = Math.floor(i / cols);
        const speed = 0.8 + Math.random() * 1.2;
        const angle = Math.random() * Math.PI * 2;
        return {
          x: col * (BUBBLE_SIZE + 8) + BUBBLE_SIZE / 2 + 4,
          y: row * (BUBBLE_SIZE + 8) + BUBBLE_SIZE / 2 + 4,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
        };
      });
    }

    function tick() {
      const W = (containerRef.current && containerRef.current.offsetWidth) || 300;
      const particles = physicsRef.current;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        // Bounce off walls
        if (p.x - BUBBLE_SIZE / 2 < 0)  { p.x = BUBBLE_SIZE / 2;       p.vx =  Math.abs(p.vx); }
        if (p.x + BUBBLE_SIZE / 2 > W)  { p.x = W - BUBBLE_SIZE / 2;   p.vx = -Math.abs(p.vx); }
        if (p.y - BUBBLE_SIZE / 2 < 0)  { p.y = BUBBLE_SIZE / 2;       p.vy =  Math.abs(p.vy); }
        if (p.y + BUBBLE_SIZE / 2 > BOUNCE_H) { p.y = BOUNCE_H - BUBBLE_SIZE / 2; p.vy = -Math.abs(p.vy); }
        const el = elRefs.current[i];
        if (el) {
          el.style.left = (p.x - BUBBLE_SIZE / 2) + 'px';
          el.style.top  = (p.y - BUBBLE_SIZE / 2) + 'px';
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [bouncing, total]);

  const allItems = [
    ...shown.map((a, i) => ({ key: a.name, a, isMore: false, i })),
    ...(rest > 0 ? [{ key: '__more__', a: null, isMore: true, i: shown.length }] : []),
  ];

  return html`
    <div
      class="demo-bubbles"
      ref=${containerRef}
      style=${bouncing ? { position: 'relative', height: BOUNCE_H + 'px' } : {}}
    >
      ${allItems.map(({ key, a, isMore, i }) => {
        const img = a && AUTHOR_IMAGES[a.name];
        const bgStyle = isMore
          ? {}
          : (img ? {} : { backgroundColor: initialsColor(a.name) });
        return html`
          <div
            class=${'demo-bubble' + (isMore ? ' demo-bubble-more' : '')}
            key=${key}
            title=${isMore ? `+${rest} more authors` : a.name}
            ref=${el => { elRefs.current[i] = el; }}
            style=${{ ...bgStyle, ...(bouncing ? { position: 'absolute' } : {}) }}
          >
            ${isMore
              ? html`<span class="demo-bubble-initials">+${rest}</span>`
              : img
                ? html`<img class="demo-bubble-img" src=${img} alt=${a.name} loading="lazy" />`
                : html`<span class="demo-bubble-initials">${getInitials(a.name)}</span>`
            }
          </div>
        `;
      })}
    </div>
  `;
}

// ─── Settings gear ──────────────────────────────────────────────────────────

function SettingsGear({ mode, onModeChange, bouncing, onBouncingChange }) {
  const [open, setOpen] = useState(false);

  return html`
    <div class="demo-settings">
      <button
        class="demo-settings-btn"
        onClick=${() => setOpen(!open)}
        title="Display settings"
        aria-label="Display settings"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
        </svg>
      </button>
      ${open && html`
        <div class="demo-settings-dropdown">
          <div class="demo-settings-title">Card display</div>
          <label class="demo-settings-option">
            <input
              type="radio"
              name="demo-display-mode"
              checked=${mode === 'names'}
              onChange=${() => { onModeChange('names'); setOpen(false); }}
            />
            <span>Show name list</span>
          </label>
          <label class="demo-settings-option">
            <input
              type="radio"
              name="demo-display-mode"
              checked=${mode === 'images'}
              onChange=${() => { onModeChange('images'); setOpen(false); }}
            />
            <span>Show author images</span>
          </label>
          <div class="demo-settings-divider"></div>
          <label class="demo-settings-option">
            <input
              type="checkbox"
              checked=${bouncing}
              onChange=${(e) => onBouncingChange(e.target.checked)}
            />
            <span>Bounce authors</span>
          </label>
        </div>
      `}
      ${open && html`<div class="demo-settings-backdrop" onClick=${() => setOpen(false)} />`}
    </div>
  `;
}

// ─── Single publication card ────────────────────────────────────────────────

function PubCard({ pub, displayMode, bouncing, expanded, onToggle, cardStyle }) {
  const previewRef = useRef(null);

  useEffect(() => {
    if (expanded && previewRef.current) {
      previewRef.current.innerHTML = '';
      createPreview(previewRef.current, pub.authors);
    }
  }, [expanded]);

  const doiHref = pub.doi ? `https://doi.org/${pub.doi}` : null;

  return html`
    <div class=${'demo-card' + (expanded ? ' demo-card-expanded' : '')} style=${cardStyle}>
      <div class="demo-card-header">
        <div class="demo-card-top-row">
          <a
            class="demo-card-meta-link"
            href=${doiHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg class="demo-card-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="demo-card-type">publication</span>
            <span class="demo-card-sep">/</span>
            <span class="demo-card-year">${pub.year}</span>
          </a>
          <button
            class="demo-explore-btn"
            onClick=${onToggle}
          >
            ${expanded ? 'Collapse' : 'Explore'}
          </button>
        </div>
        <a
          class="demo-card-link"
          href=${doiHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          <h3 class="demo-card-title">${pub.title}</h3>
        </a>
        <div class="demo-card-journal">${pub.journal}</div>
        <div class="demo-card-authors">
          ${displayMode === 'images'
            ? html`<${AuthorBubbles} authors=${pub.authors} bouncing=${bouncing} />`
            : html`<${AuthorByline} authors=${pub.authors} />`
          }
        </div>
      </div>
      ${expanded && html`
        <div class="demo-card-preview" ref=${previewRef}></div>
      `}
    </div>
  `;
}

// ─── Page layout ────────────────────────────────────────────────────────────

function DemoPage() {
  const [displayMode, setDisplayMode] = useState('images');
  const [bouncing, setBouncing] = useState(false);
  const [expandedDoi, setExpandedDoi] = useState(null);
  const gridRef = useRef(null);
  const [cols, setCols] = useState(3);

  // Track column count via ResizeObserver so ordering matches the live layout
  useEffect(() => {
    function update() {
      if (!gridRef.current) return;
      const w = gridRef.current.offsetWidth;
      setCols(w >= 900 ? 3 : w >= 600 ? 2 : 1);
    }
    update();
    const obs = new ResizeObserver(update);
    if (gridRef.current) obs.observe(gridRef.current);
    return () => obs.disconnect();
  }, []);

  const expandedIdx = expandedDoi
    ? PUBLICATIONS.findIndex(p => p.doi === expandedDoi)
    : -1;

  // Compute per-card style: expanded card spans full width; cards that share its
  // row but sit to its left get pushed below via CSS `order`.
  function cardStyle(idx) {
    if (expandedIdx === -1 || cols <= 1) {
      return idx === expandedIdx ? { gridColumn: '1 / -1' } : {};
    }

    const rowStart = Math.floor(expandedIdx / cols) * cols;
    const rowEnd   = rowStart + cols - 1;

    if (idx === expandedIdx) {
      // Expanded card: anchor to front of its row, span full width
      return { order: rowStart, gridColumn: '1 / -1' };
    }
    if (idx >= rowStart && idx <= rowEnd) {
      // Same-row peers: push immediately after the expanded card
      const peerPos = idx < expandedIdx
        ? idx - rowStart             // peer was to the left
        : idx - rowStart - 1;        // peer was to the right
      return { order: rowStart + 1 + peerPos };
    }
    // All other cards keep their natural order
    return {};
  }

  function toggleCard(doi) {
    setExpandedDoi(prev => prev === doi ? null : doi);
  }

  return html`
    <div class="demo-page">
      <div class="demo-page-header">
        <div class="demo-page-header-row">
          <div>
            <h1>Allen Institute Publications</h1>
            <p class="demo-page-subtitle">
              Recent publications with author contribution tracking.
              Click <strong>Explore</strong> to view the full contribution widget.
            </p>
          </div>
          <${SettingsGear}
            mode=${displayMode}
            onModeChange=${setDisplayMode}
            bouncing=${bouncing}
            onBouncingChange=${setBouncing}
          />
        </div>
      </div>
      <div class="demo-grid" ref=${gridRef}>
        ${PUBLICATIONS.map((pub, idx) => html`
          <${PubCard}
            key=${pub.doi}
            pub=${pub}
            displayMode=${displayMode}
            bouncing=${bouncing}
            expanded=${expandedDoi === pub.doi}
            onToggle=${() => toggleCard(pub.doi)}
            cardStyle=${cardStyle(idx)}
          />
        `)}
      </div>
    </div>
  `;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function injectDemoStyles() {
  if (document.getElementById('demo-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'demo-page-styles';
  style.textContent = `
    /* Override page background for the demo page */
    body:has(.demo-page) {
      background-color: rgb(243, 240, 232) !important;
    }

    .demo-page {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    .demo-page-header {
      margin-bottom: 32px;
    }
    .demo-page-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    .demo-page-header h1 {
      font-family: 'AllenInstitutePlusHeadline', 'AllenInstitutePlusText', Arial, sans-serif;
      font-size: 24px;
      font-weight: 700;
      color: #000;
      margin: 0 0 8px;
    }
    .demo-page-subtitle {
      font-size: 14px;
      color: #6b7280;
      margin: 0;
    }
    .demo-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    @media (max-width: 900px) {
      .demo-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .demo-grid { grid-template-columns: 1fr; }
    }

    /* Card */
    .demo-card {
      background: rgb(243, 240, 232);
      border: 1px solid rgb(170, 163, 159);
      border-radius: 12px;
      padding: 20px;
      transition: box-shadow 0.2s;
      display: flex;
      flex-direction: column;
    }
    .demo-card:hover {
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .demo-card-expanded {
      border-color: rgb(255, 110, 0);
      box-shadow: 0 4px 16px rgba(255, 110, 0, 0.10);
    }

    /* Top row: meta on left, explore button on right */
    .demo-card-top-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }

    /* Meta link (icon + publication / year) */
    .demo-card-meta-link {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #000;
      letter-spacing: 0.03em;
      text-decoration: none;
    }
    .demo-card-icon {
      flex-shrink: 0;
      color: #000;
    }
    .demo-card-type { font-weight: 600; }
    .demo-card-sep { color: #999; }

    /* Title link */
    .demo-card-link {
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .demo-card-link:hover .demo-card-title {
      color: rgb(130, 70, 255);
    }

    .demo-card-title {
      font-family: 'AllenInstitutePlusHeadline', 'AllenInstitutePlusText', Arial, sans-serif;
      font-size: 16px;
      font-weight: 700;
      color: #000;
      margin: 0 0 6px;
      line-height: 1.35;
      transition: color 0.45s;
    }
    .demo-card-journal {
      font-size: 13px;
      color: #000;
      margin-bottom: 10px;
    }

    /* Author byline (name list mode) */
    .demo-card-authors {
      font-size: 13px;
      color: #000;
      margin-bottom: 0;
      line-height: 1.5;
    }
    .demo-author-name {
      font-weight: 500;
    }
    .demo-author-more {
      color: #6b7280;
      font-style: italic;
    }

    /* Author bubbles (image mode) */
    .demo-bubbles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .demo-bubble {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      overflow: hidden;
      background: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
      cursor: default;
      transition: transform 0.15s, box-shadow 0.15s;
      border: 2px solid rgb(170, 163, 159);
    }
    .demo-bubble:hover {
      transform: scale(1.15);
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 1;
    }
    .demo-bubble-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .demo-bubble-initials {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      user-select: none;
    }
    .demo-bubble:not(.demo-bubble-more) {
      background: #94a3b8;
    }
    .demo-bubble-more {
      background: #9ca3af;
    }

    /* Explore button */
    .demo-explore-btn {
      padding: 5px 14px;
      border-radius: 8px;
      border: none;
      background: rgb(255, 110, 0);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .demo-explore-btn:hover {
      background: rgb(230, 95, 0);
    }
    .demo-explore-btn:active {
      transform: scale(0.97);
    }
    .demo-card-expanded .demo-explore-btn {
      background: transparent;
      color: rgb(255, 110, 0);
      border: 1px solid rgb(255, 110, 0);
    }
    .demo-card-expanded .demo-explore-btn:hover {
      background: rgba(255, 110, 0, 0.06);
    }

    /* Expanded preview area */
    .demo-card-preview {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(0, 0, 0, 0.1);
    }

    /* Settings gear */
    .demo-settings {
      position: relative;
      flex-shrink: 0;
    }
    .demo-settings-btn {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: 1px solid rgba(0, 0, 0, 0.1);
      background: rgb(243, 240, 232);
      color: #000;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s, color 0.15s;
    }
    .demo-settings-btn:hover {
      border-color: rgba(0, 0, 0, 0.25);
    }
    .demo-settings-dropdown {
      position: absolute;
      top: 42px;
      right: 0;
      background: #fff;
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      padding: 12px 16px;
      min-width: 200px;
      z-index: 100;
      animation: demo-dropdown-in 0.12s ease-out;
    }
    @keyframes demo-dropdown-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .demo-settings-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #6b7280;
      margin-bottom: 8px;
    }
    .demo-settings-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 13px;
      color: #000;
      cursor: pointer;
    }
    .demo-settings-option input[type="radio"] {
      accent-color: rgb(255, 110, 0);
    }
    .demo-settings-backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
    }
    .demo-settings-divider {
      border: none;
      border-top: 1px solid rgba(0,0,0,0.08);
      margin: 6px 0;
    }


    /* Dark mode */
    [data-theme="dark"] .demo-card {
      background: #1f2937;
      border-color: #374151;
    }
    [data-theme="dark"] .demo-card:hover {
      border-color: #4b5563;
    }
    [data-theme="dark"] .demo-card-expanded {
      border-color: rgb(255, 110, 0);
      box-shadow: 0 4px 16px rgba(255, 110, 0, 0.15);
    }
    [data-theme="dark"] .demo-card-title {
      color: #f3f4f6;
    }
    [data-theme="dark"] .demo-card-authors {
      color: #d1d5db;
    }
    [data-theme="dark"] .demo-card-link:hover .demo-card-title {
      color: rgb(130, 70, 255);
    }
    [data-theme="dark"] .demo-settings-btn {
      background: #1f2937;
      border-color: #374151;
      color: #9ca3af;
    }
    [data-theme="dark"] .demo-settings-btn:hover {
      border-color: #6b7280;
      color: #d1d5db;
    }
    [data-theme="dark"] .demo-settings-dropdown {
      background: #1f2937;
      border-color: #374151;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    [data-theme="dark"] .demo-settings-option {
      color: #d1d5db;
    }
    [data-theme="dark"] .demo-bubble {
      border-color: #1f2937;
      background: #4b5563;
    }
    [data-theme="dark"] .demo-bubble:not(.demo-bubble-more) {
      background: #64748b;
    }
    [data-theme="dark"] .demo-bubble-more {
      background: #6b7280;
    }
  `;
  document.head.appendChild(style);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export function createDemoPage() {
  injectDemoStyles();
  const container = document.createElement('div');
  render(html`<${DemoPage} />`, container);
  return container;
}
