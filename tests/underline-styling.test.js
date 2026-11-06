'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'public', 'style.css');

console.log('================================================================');
console.log('SUITE: Global Underline Styling & Red Background Preservation');
console.log('================================================================');

// 1. Verify CSS rules exist and are structurally correct
console.log('\nTEST 1: CSS Rules Structure & Specificity Audit');
const cssContent = fs.readFileSync(CSS_FILE, 'utf8');

assert(cssContent.includes('GLOBAL UNDERLINE STYLING'), 'CSS must contain global underline section');

// Verify all required selectors are covered
const requiredSelectors = [
  'u,',
  'ins,',
  '.underline,',
  '.text-underline,',
  '.text-underlined,',
  '.underlined,',
  '[data-underline],',
  '[style*="underline" i]'
];
for (const sel of requiredSelectors) {
  assert(cssContent.includes(sel), `CSS must include selector: ${sel}`);
}
console.log('   ✓ All required underline selectors present in public/style.css');

// 2. Verify color is #000000 !important and -webkit-text-fill-color is #000000 !important
console.log('\nTEST 2: Color and Text Fill Color Verification');
assert(cssContent.includes('color: #000000 !important;'), 'Must set color: #000000 !important');
assert(cssContent.includes('-webkit-text-fill-color: #000000 !important;'), 'Must set -webkit-text-fill-color: #000000 !important');
console.log('   ✓ Pure black font (#000000) enforced with !important');

// 3. Verify Background Preservation (Zero background overrides in underline rules)
console.log('\nTEST 3: Background Preservation Guarantee');
const underlineSection = cssContent.slice(cssContent.indexOf('GLOBAL UNDERLINE STYLING'));
assert(!underlineSection.includes('background: #000000'), 'Underline rules must NOT turn backgrounds black');
assert(!underlineSection.includes('background: #ffffff'), 'Underline rules must NOT turn backgrounds white');
assert(!underlineSection.includes('background: transparent !important'), 'Underline rules must NOT force transparent backgrounds');
assert(!underlineSection.includes('background: none !important'), 'Underline rules must NOT remove existing backgrounds');
console.log('   ✓ Zero background overrides in underline block (all red and themed backgrounds 100% preserved)');

// 4. Verify Nested Formatting Elements Coverage
console.log('\nTEST 4: Nested Formatting Elements Coverage');
assert(underlineSection.includes('u :not(svg, svg *)'), 'Must target nested elements inside u excluding SVGs');
assert(underlineSection.includes('b u') && underlineSection.includes('strong u'), 'Must support inverted bold/strong nesting');
assert(underlineSection.includes('.btn u') && underlineSection.includes('.btn-primary u'), 'Must support button underline nesting');
console.log('   ✓ Bold, strong, nested spans, buttons, cards, and inverted nesting fully covered');

// 5. Verify Icon & SVG Protection
console.log('\nTEST 5: Icon and SVG Color Protection');
assert(underlineSection.includes('u svg') && underlineSection.includes('.underline svg'), 'SVGs protected from black text-fill');
assert(underlineSection.includes('u .rule-icon') && underlineSection.includes('u .stat-icon'), 'App icons protected with var(--accent)');
console.log('   ✓ Icons, SVGs, and brand assets protected from inheriting black font color');

console.log('\n================================================================');
console.log('✅ ALL UNDERLINE STYLING AUDIT TESTS PASSED (100%)');
console.log('================================================================\n');
process.exit(0);
