// Least-squares fit to the public mouse-t1 v1.0 paired CCF/template mesh vertices (80% training, seed 42).
// Source: https://aind-scratch-data.s3.amazonaws.com/rutter/packs/mouse-t1/v1.0/files/brainglobe_meshes_in_build5/
const CCF_LPS_TO_BUILD5 = [
  [0.986324645912426, 0.009096725613992844, -0.00576073726591145, 5.584668489846521],
  [-0.008215211575344623, 1.028757177195729, 0.05465974852643449, -5.782682783141374],
  [0.006810441006372729, -0.06773234962151282, 0.8842580128968477, 0.6926395340638822],
];

/** Map left-origin QC CCF indices to build5 LPS mm; the affine has 0.172 mm median mesh error. */
export function ccfIndexToBuild5({ ap, dv, ml }) {
  if (![ap, dv, ml].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
  // QC ML increases left→right; the fitted BrainGlobe coordinates increase right→left across 11.4 mm.
  const ccfLps = [ml * 0.025 - 11.4, ap * 0.025, -dv * 0.025];
  return CCF_LPS_TO_BUILD5.map(row => row[3] + ccfLps.reduce((sum, value, i) => sum + row[i] * value, 0));
}
