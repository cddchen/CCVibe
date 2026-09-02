import { describe, expect, it } from 'vitest';

import {
  HOME_TITLE_REVEAL_END,
  HOME_TITLE_REVEAL_START,
  homeTitleProgress,
} from '../src/features/home/homeScroll';
import { composerKeyboardTranslation } from '../src/features/home/homeKeyboard';

describe('home compact title scroll affordance', () => {
  it('keeps the large hero title unobscured at the top', () => {
    expect(homeTitleProgress(0)).toBe(0);
    expect(homeTitleProgress(HOME_TITLE_REVEAL_START)).toBe(0);
  });

  it('cross-fades the material title while the hero leaves the viewport', () => {
    expect(homeTitleProgress((HOME_TITLE_REVEAL_START + HOME_TITLE_REVEAL_END) / 2)).toBe(0.5);
    expect(homeTitleProgress(HOME_TITLE_REVEAL_END)).toBe(1);
  });

  it('clamps the title to hidden or fully visible at either edge', () => {
    expect(homeTitleProgress(-40)).toBe(0);
    expect(homeTitleProgress(HOME_TITLE_REVEAL_END + 500)).toBe(1);
    expect(homeTitleProgress(Number.NaN)).toBe(0);
  });

  it('translates a covered composer exactly to the keyboard top', () => {
    expect(composerKeyboardTranslation({ pageY: 620, height: 240 }, 900, -360)).toBe(-320);
  });

  it('does not move a composer that is already above the keyboard', () => {
    expect(composerKeyboardTranslation({ pageY: 280, height: 180 }, 900, -360)).toBe(0);
  });
});
