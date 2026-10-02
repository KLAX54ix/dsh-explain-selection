/**
 * Client half of the explain-selection bundle.
 *
 * Renders into the frame-wide `shell.overlay` slot (pointer-events:none by
 * default, so the layer never blocks the app underneath; each surface opts back
 * in). Three behaviours live here:
 *
 *   1. a floating "解释" action beside any non-empty text selection;
 *   2. a streaming explanation card anchored to the exact Range the user
 *      selected, which follows the anchor through scrolling and resizing;
 *   3. the same selection handler applies to the card's own text, so
 *      explaining a term inside an explanation needs no new machinery.
 *
 * Answers stream from the Host route registered in ./index.js. The main
 * conversation is neither read nor written.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-explain-selection',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;
    const h = React.createElement;

    /** Document-relative form of the Host route (`/api/explain.selection`). */
    const ROUTE = 'api/explain.selection';
    const MAX_SELECTION_CHARS = 1200;
    const CARD_WIDTH = 380;
    const GAP = 8;
    /** Minimum of a collapsed chip to keep on screen; its real width is content-driven. */
    const CHIP_MIN_WIDTH = 96;
    /** Height reserved when deciding whether the chip flips above its text. */
    const CHIP_HEIGHT = 30;

    /** Marks our interactive controls so a click on them never spawns the toolbar. */
    const CONTROL = 'data-explain-control';

    /**
     * Identifies one rendered card, so a selection can name the card it sits in.
     * Unlike {@link CONTROL} it must NOT suppress selection gestures.
     */
    const CARD_ATTR = 'data-explain-card';

    /**
     * Disambiguation window for a top-level selection: characters of surrounding
     * text on each side, plus the largest ancestor still treated as one block.
     * Roughly 160 extra input tokens per lookup.
     */
    const CONTEXT_RADIUS = 120;
    const CONTEXT_BLOCK_CAP = 600;

    /**
     * Marker tints for explained fragments, one per open card.
     *
     * Deliberately literal and translucent. `::highlight()` accepts only a small
     * property set, and a low-alpha tint stays legible over both the light and
     * dark theme — which matters more here than token purity, because several
     * open explanations must stay visually distinguishable from each other.
     */
    const MARKER_COLORS = [
      'rgba(255, 193, 7, 0.34)',
      'rgba(64, 158, 255, 0.30)',
      'rgba(0, 191, 125, 0.30)',
      'rgba(168, 107, 255, 0.30)',
      'rgba(255, 122, 122, 0.30)',
      'rgba(0, 191, 191, 0.30)',
    ];

    /** Registry-name prefix, so we only ever touch our own highlights. */
    const HIGHLIGHT_PREFIX = 'explain-';

    /**
     * The CSS Custom Highlight API paints a Range without mutating any DOM.
     * That is the only way to mark text owned by another surface: plugin code
     * must not wrap or restyle nodes outside its own component.
     */
    const supportsHighlight = typeof CSS !== 'undefined'
      && CSS !== null
      && typeof Highlight === 'function'
      && typeof CSS.highlights === 'object'
      && CSS.highlights !== null;

    /**
     * Pick the first marker tint not already in use by an open card, so
     * simultaneous explanations never share a color.
     * @param current - the open cards.
     * @returns an index into {@link MARKER_COLORS}.
     */
    function pickColorIndex(current) {
      const used = new Set(current.map((card) => card.colorIndex));
      for (let index = 0; index < MARKER_COLORS.length; index += 1) {
        if (!used.has(index)) return index;
      }
      return current.length % MARKER_COLORS.length;
    }

    /**
     * Answered fragments, keyed by normalized text. Nested lookups revisit the
     * same terms constantly, so a hit is the cheapest and fastest answer we can
     * give: no request, no tokens, no waiting.
     */
    const answerCache = new Map();
    const CACHE_LIMIT = 200;

    /**
     * Normalize a fragment into a cache key.
     * @param text - selected text.
     * @returns the key.
     */
    function cacheKey(text) {
      return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * Remember one answer, evicting the oldest entry past the limit.
     * @param key - normalized fragment.
     * @param answer - completed explanation text.
     */
    function remember(key, answer) {
      if (answer.trim().length === 0) return;
      if (answerCache.has(key)) answerCache.delete(key);
      answerCache.set(key, answer);
      while (answerCache.size > CACHE_LIMIT) {
        const oldest = answerCache.keys().next();
        if (oldest.done) break;
        answerCache.delete(oldest.value);
      }
    }

    /**
     * The right-click menu — and the single palette every surface shares.
     *
     * The Host builds its native context menu in the Electron main process from
     * a hardcoded template (`lib/main.js`), so a renderer plugin cannot add an
     * item to it. It does not need to: for a non-editable selection that native
     * menu holds exactly one entry, Copy. This plugin takes over that one case
     * and draws both entries itself — which is also why they are guaranteed to
     * match: 解释, 复制 and the cards all read the same theme tokens.
     */
    /**
     * Copy text to the clipboard.
     *
     * The async Clipboard API is the primary path — the Desktop page is served
     * from http://127.0.0.1, which counts as a secure context. The fallback
     * copies the live native selection instead of building a throwaway node:
     * the plugin rules forbid appending to `document.body`, and the selection
     * this menu was opened for is still intact at click time.
     * @param text - the text to copy.
     * @returns whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined'
          && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through to the selection-based copy */
      }
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }

    /**
     * The right-click menu surface.
     *
     * Same layer as the cards on purpose. `--dsw-alias-bg-overlay` is the token the
     * system uses for material-backed popovers, but in the light theme that is
     * `rgb(233,236,242)` — a grey — so a menu built on it sat next to white cards as
     * the odd one out, and in the dark theme it is `rgb(97,102,107)` against layers
     * of `rgb(35..53)`. Our menu floats over the same opaque surface the cards do,
     * so it takes the same treatment; there is nothing behind it for a backdrop
     * filter to reveal.
     */
    const menuStyle = {
      position: 'fixed',
      zIndex: 5,
      minWidth: '136px',
      padding: '4px',
      borderRadius: '8px',
      border: '.5px solid var(--dsw-elevation-stroke-color)',
      background: 'var(--dsw-alias-bg-layer-3)',
      boxShadow: 'var(--dsw-shadow-lv3)',
      pointerEvents: 'auto',
      userSelect: 'none',
    };

    /** Shared by every menu entry, so 解释 and 复制 cannot drift apart. */
    const menuItemStyle = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '1.4',
      textAlign: 'left',
      padding: '6px 12px',
      borderRadius: '6px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    const MENU_ITEM_CLASS = 'dsh-explain-menu-item';

    /**
     * Pseudo-classes cannot be expressed inline, so they ship as one static rule set.
     *
     * Hover uses the system's own interaction token. It used to use
     * `--dsw-alias-bg-layer-2`, which is white in the light theme — invisible as a
     * hover state on a white menu.
     */
    const MENU_CSS = [
      `.${MENU_ITEM_CLASS}:hover,.${MENU_ITEM_CLASS}:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}`,
      `.${MENU_ITEM_CLASS}:focus{outline:none;}`,
    ].join('');

    /** A term the model marked as new: clickable, and visibly so. */
    const termSpanStyle = {
      borderBottom: '1px dotted var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
    };

    /**
     * The card surface.
     *
     * Deliberately *not* `--dsw-alias-bg-overlay`. That token belongs to transient
     * popovers and menus, and it is far lighter than the app's own layers: light
     * `rgb(233,236,242)` against a pure-white base, dark `rgb(97,102,107)` against
     * layers of `rgb(35,35,36)`–`rgb(53,54,56)`. On a card you keep reading from,
     * that is a pale slab pasted over the interface. `bg-layer-3` is the app's own
     * top layer, so the card sits *with* the surface instead of on top of it.
     *
     * The stroke and the shadow are the design system's own elevation recipe
     * (`--dsw-elevation-stroke-color` + `--dsw-shadow-lv3`) rather than hand-picked
     * numbers. The previous pair — a 1px `rgba(0,0,0,.1)` border under
     * `0 10px 28px rgba(0,0,0,.22)` — was roughly three times heavier than the
     * strongest level the system defines (lv3's largest layer is `.08`).
     */
    const cardStyle = {
      position: 'fixed',
      zIndex: 3,
      width: `${CARD_WIDTH}px`,
      maxWidth: 'calc(100vw - 16px)',
      boxSizing: 'border-box',
      padding: '10px 12px 12px',
      borderRadius: '10px',
      border: '.5px solid var(--dsw-elevation-stroke-color)',
      background: 'var(--dsw-alias-bg-layer-3)',
      boxShadow: 'var(--dsw-shadow-lv3)',
      color: 'var(--dsw-alias-label-primary)',
      pointerEvents: 'auto',
      fontSize: '13px',
      lineHeight: '1.65',
      // The frame-wide overlay sits outside the transcript, so it can inherit a
      // shell-level `user-select: none`. State it here: card text must be
      // selectable, or nesting has no entry point.
      userSelect: 'text',
      WebkitUserSelect: 'text',
    };

    /** The collapsed card is the same surface, at chip scale and lower elevation. */
    const chipStyle = {
      position: 'fixed',
      zIndex: 3,
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      maxWidth: '260px',
      padding: '4px 10px',
      borderRadius: '999px',
      border: '.5px solid var(--dsw-elevation-stroke-color)',
      background: 'var(--dsw-alias-bg-layer-3)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: 'var(--dsw-shadow-lv2)',
      pointerEvents: 'auto',
      cursor: 'pointer',
      fontSize: '12px',
      lineHeight: '1.4',
    };

    /** The card header: a row holding the drag handle and the card's buttons. */
    const headStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      marginBottom: '6px',
    };

    /**
     * The drag handle is its own element *beside* the buttons, never their
     * ancestor. If the pointerdown handler sat on the header, every press on a
     * button would bubble into the drag path — and a drag that captures the
     * pointer retargets the compatibility mouse events, so the `click` that
     * follows lands on the handle instead of the button. That silently killed
     * 收起 / 关闭 / 回到原文.
     */
    const dragHandleStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      flex: '1 1 auto',
      minWidth: 0,
      cursor: 'move',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      touchAction: 'none',
    };

    /** Affordance for the drag handle; purely decorative. */
    const gripStyle = {
      flex: '0 0 auto',
      fontSize: '10px',
      lineHeight: '1',
      letterSpacing: '-1px',
      color: 'var(--dsw-alias-label-secondary)',
      opacity: 0.65,
    };

    /**
     * The drag tether layer.
     *
     * A card can be parked anywhere, which is what makes a desk of cards turn
     * into a pile: nothing on screen says which words a card came from. While a
     * card is being dragged this layer draws a faint dashed line back to the
     * exact text it explains, so the arrangement stays tethered to the document
     * instead of drifting into an anonymous heap.
     *
     * Sits *below* the cards (z-index 2 against their 3) so a tether never draws
     * across another card's content.
     */
    const dragLayerStyle = {
      position: 'fixed',
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      zIndex: 2,
      pointerEvents: 'none',
      overflow: 'visible',
    };

    /** Faint, so it reads as a guide rather than as content. */
    const TETHER_STROKE = 'var(--dsw-alias-brand-primary)';
    const TETHER_OPACITY = 0.4;

    const termStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: 600,
      fontSize: '12.5px',
      color: 'var(--dsw-alias-label-secondary)',
    };

    const iconButtonStyle = {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '14px',
      lineHeight: '1',
      padding: '2px 6px',
      borderRadius: '6px',
      cursor: 'pointer',
    };

    const bodyStyle = {
      maxHeight: '46vh',
      overflowY: 'auto',
      overflowX: 'hidden',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      userSelect: 'text',
      WebkitUserSelect: 'text',
      cursor: 'text',
    };

    const statusStyle = { marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };

    /** Muted provenance line: what disambiguation this card was answered with. */
    const provenanceStyle = {
      marginTop: '6px',
      paddingTop: '6px',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      fontSize: '11px',
      lineHeight: '1.4',
      color: 'var(--dsw-alias-label-secondary)',
      userSelect: 'text',
    };

    /**
     * Read the user's current selection, rejecting editable fields and empty ranges.
     *
     * The selection is taken exactly as the user made it — never widened. The
     * marker must cover precisely the characters they chose; surrounding text
     * reaches the model only as context, never as the explained fragment.
     * @returns `{ text, range, rect, parentId }`, or null when there is nothing to explain.
     */
    function readSelection() {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
      const text = selection.toString().trim();
      if (text.length === 0) return null;

      // Clone so the captured range keeps its own boundary points once the
      // browser selection moves on — the marker and the card anchor depend on it.
      const range = selection.getRangeAt(0).cloneRange();
      const node = range.commonAncestorContainer;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element !== null && element.closest('input, textarea, [contenteditable="true"]') !== null) return null;

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;

      // A selection inside one of our own cards is a nested lookup: that card is
      // the context, so the caller can send its explanation instead of a DOM slice.
      const host = element === null ? null : element.closest(`[${CARD_ATTR}]`);
      const parentId = host === null ? null : host.getAttribute(CARD_ATTR);

      return { text: text.slice(0, MAX_SELECTION_CHARS), range, rect, parentId };
    }

    /**
     * The nearest ancestor that still reads as one block of prose.
     * @param element - the element containing the selection.
     * @returns the block element to read text from.
     */
    function nearestBlock(element) {
      let best = element;
      let current = element.parentElement;
      for (let depth = 0; depth < 5 && current !== null; depth += 1) {
        if ((current.textContent ?? '').length > CONTEXT_BLOCK_CAP) break;
        best = current;
        // One of our cards is the natural unit; never climb past it into the
        // frame-wide overlay, which would mix in unrelated cards.
        if (current.hasAttribute(CARD_ATTR)) break;
        current = current.parentElement;
      }
      return best;
    }

    /**
     * Character offset of one Range boundary inside a block's raw text.
     * Offsets must be measured against the unnormalized text, because that is
     * exactly what the boundary offsets index into.
     * @param block - the block element.
     * @param container - the boundary's container node.
     * @param offset - the boundary's offset within that container.
     * @returns the character offset, or -1 when it cannot be resolved.
     */
    function rawOffsetOf(block, container, offset) {
      if (container.nodeType !== 3) return -1;
      let total = 0;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        if (node === container) return total + offset;
        total += node.nodeValue === null ? 0 : node.nodeValue.length;
        node = walker.nextNode();
      }
      return -1;
    }

    /**
     * A bounded slice of prose around a selection, used only to disambiguate a
     * term that has several unrelated meanings.
     *
     * The window is located from the Range's own offsets, never by searching the
     * block for the selected text: a word that appears twice would otherwise
     * always resolve to its first occurrence, feeding the model the wrong
     * sentence while looking correct.
     *
     * This reads text from another surface's DOM. The plugin rules forbid that
     * for estimating placement; here it only reads (never writes) the words the
     * user is already looking at, and the result is hard-capped.
     * @param range - the selection range.
     * @returns surrounding text, or '' when none can be read.
     */
    function contextWindow(range) {
      const node = range.commonAncestorContainer;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element === null) return '';

      const block = nearestBlock(element);
      // Slice the RAW text: the Range offsets index into it. Collapsing
      // whitespace first would shift every offset and misplace the window.
      const raw = block.textContent ?? '';
      if (raw.trim().length === 0) return '';

      const start = rawOffsetOf(block, range.startContainer, range.startOffset);
      if (start === -1) {
        // The boundary is not a text position, so the window cannot be located.
        // A leading slice would describe a different sentence and invite a
        // confidently wrong answer, so only an unambiguous whole-block window
        // is safe — otherwise report no context at all.
        return raw.length <= CONTEXT_RADIUS * 2 ? raw.replace(/\s+/g, ' ').trim() : '';
      }
      const end = rawOffsetOf(block, range.endContainer, range.endOffset);
      const stop = end === -1 || end < start ? start : end;

      const slice = raw.slice(Math.max(0, start - CONTEXT_RADIUS), Math.min(raw.length, stop + CONTEXT_RADIUS));
      return slice.replace(/\s+/g, ' ').trim();
    }

    /**
     * Drop the `[[term]]` markers for places that render plain text
     * (the card header and the collapsed chip).
     * @param text - raw model output.
     * @returns display text.
     */
    function stripMarkers(text) {
      return text.replace(/\[\[([^\]]+)\]\]/g, '$1');
    }

    /**
     * Render explanation text with `[[term]]` markers turned into clickable
     * terms. This is the nesting gesture: one click on a marked term opens its
     * own card, so an explanation never has to be read as a wall of nested
     * definitions.
     * @param text - raw model output.
     * @param onTerm - invoked with the term and its rendered element.
     * @returns React children.
     */
    function renderContent(text, onTerm) {
      const parts = [];
      const pattern = /\[\[([^\]]+)\]\]/g;
      let cursor = 0;
      let index = 0;
      let match = pattern.exec(text);

      while (match !== null) {
        if (match.index > cursor) parts.push(text.slice(cursor, match.index));
        const term = match[1];
        parts.push(
          h(
            'span',
            {
              key: `term-${index}`,
              role: 'button',
              tabIndex: 0,
              title: `解释「${term}」`,
              style: termSpanStyle,
              onClick: (event) => onTerm(term, event.currentTarget),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onTerm(term, event.currentTarget);
              },
            },
            term,
          ),
        );
        index += 1;
        cursor = match.index + match[0].length;
        match = pattern.exec(text);
      }

      if (cursor < text.length) {
        // While streaming, a marker can arrive half-written. Hold back an
        // unterminated `[[…` instead of flashing raw brackets.
        const tail = text.slice(cursor);
        const open = tail.lastIndexOf('[[');
        if (open !== -1 && tail.indexOf(']]', open) === -1) parts.push(tail.slice(0, open));
        else parts.push(tail);
      }
      return parts;
    }

    /**
     * The id of the card whose body a card's anchor lives inside, or null when it
     * anchors in the transcript.
     *
     * Read from the DOM instead of stored in state: the relationship *is* "which
     * card element contains my Range", and a stored copy would need invalidating
     * every time a card is closed. Works on detached trees too, so a nested card
     * whose ancestor was minimized still resolves to that ancestor's id.
     * @param card - the card to locate.
     * @returns the enclosing card's id, or null.
     */
    function parentIdOf(card) {
      const range = card.range;
      if (range === null || range === undefined) return null;
      const node = range.startContainer;
      if (node === null || node === undefined) return null;
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element === null) return null;
      const owner = element.closest(`[${CARD_ATTR}]`);
      return owner === null ? null : owner.getAttribute(CARD_ATTR);
    }

    /**
     * Current viewport rectangle for an anchor, falling back to the rectangle
     * captured when the Range's nodes were replaced.
     *
     * Every anchored surface must go through this: a rectangle frozen at
     * selection time stops tracking the text as soon as the page scrolls.
     * @param range - the anchor Range.
     * @param fallback - the rectangle captured at selection time.
     * @returns a DOMRect-like rectangle.
     */
    function anchorRect(range, fallback) {
      try {
        const rect = range.getBoundingClientRect();
        if (rect.width !== 0 || rect.height !== 0) return rect;
      } catch {
        /* detached range after a re-render: fall through to the captured rect */
      }
      return fallback;
    }

    /**
     * Place a fixed-position box beside an anchor, flipping above the anchor
     * near the bottom edge and clamping horizontally.
     * @param rect - anchor rectangle in viewport coordinates.
     * @param width - the box width in pixels.
     * @param height - vertical space to reserve when flipping.
     * @returns style properties carrying either `top` or `bottom`.
     */
    function placeBeside(rect, width, height) {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const effectiveWidth = Math.min(width, viewportWidth - 16);

      let left = rect.left;
      if (left + effectiveWidth > viewportWidth - 8) left = viewportWidth - 8 - effectiveWidth;
      if (left < 8) left = 8;

      const below = rect.bottom + GAP;
      const roomBelow = viewportHeight - below;
      const wantAbove = roomBelow < height && rect.top >= height;
      if (wantAbove) return { left: `${left}px`, bottom: `${viewportHeight - rect.top + GAP}px` };
      return { left: `${left}px`, top: `${below}px` };
    }

    /**
     * Place the collapsed chip on its text.
     *
     * Separate from {@link placeBeside} because the chip has no fixed width — its
     * content decides, up to a cap. Reserving that cap as the layout width pushed
     * the chip up to 260px to the left of the words it belongs to whenever the
     * anchor sat near the right edge, which reads as the chip "not going back to
     * the text". Reserving only a minimum keeps it on the words, and deriving the
     * cap from the space that actually remains keeps it on screen without
     * measuring the element.
     * @param rect - anchor rectangle in viewport coordinates.
     * @returns style properties for the chip.
     */
    function placeChipBeside(rect) {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.min(
        Math.max(rect.left, 8),
        Math.max(8, viewportWidth - 8 - CHIP_MIN_WIDTH),
      );
      const below = rect.bottom + GAP;
      const roomBelow = viewportHeight - below;
      const wantAbove = roomBelow < CHIP_HEIGHT && rect.top >= CHIP_HEIGHT;
      return {
        left: `${left}px`,
        maxWidth: `min(260px, calc(100vw - ${left}px - 8px))`,
        ...(wantAbove
          ? { top: 'auto', bottom: `${viewportHeight - rect.top + GAP}px` }
          : { top: `${below}px`, bottom: 'auto' }),
      };
    }

    /**
     * Where a line from a rectangle's center toward a point leaves that rectangle.
     * @param rect - the rectangle the line starts from.
     * @param toward - the point the line aims at.
     * @returns the border point closest to that aim.
     */
    function edgePoint(rect, toward) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = toward.x - centerX;
      const dy = toward.y - centerY;
      if (dx === 0 && dy === 0) return { x: centerX, y: centerY };

      const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (rect.width / 2) / Math.abs(dx);
      const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (rect.height / 2) / Math.abs(dy);
      // Clamped at 1: when the target sits inside the rectangle the tether is
      // meaningless, so it collapses to the center rather than overshooting.
      const scale = Math.min(scaleX, scaleY, 1);
      return { x: centerX + dx * scale, y: centerY + dy * scale };
    }

    /**
     * Keep a dragged card reachable: never let it leave the frame entirely.
     * @param value - the proposed coordinate.
     * @param min - lower bound.
     * @param max - upper bound.
     * @returns the clamped coordinate.
     */
    function clamp(value, min, max) {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    }

    /**
     * Whether a card's anchored text still exists in the document.
     *
     * A card is only meaningful while the words it explains are on screen. Once
     * the transcript is torn down (session switch, fork, workspace switch) the
     * Range's nodes are detached, `getBoundingClientRect()` returns a zero rect,
     * and positioning silently falls back to the rectangle captured at selection
     * time — which is how cards used to keep floating over a different Session.
     * @param card - the card record.
     * @returns true while the anchor is still connected.
     */
    function isAnchored(card) {
      try {
        return card.range.startContainer.isConnected;
      } catch {
        return false;
      }
    }

    /**
     * The Session the mounted Conversation belongs to.
     *
     * `shell.overlay` is root-scoped and its slot props carry no session
     * identity, so the overlay cannot observe this itself; the session-scoped
     * probe below reports it.
     */
    let activeSessionId = null;

    /** Listeners notified whenever the mounted Conversation's identity changes. */
    const sessionChangeListeners = new Set();

    /**
     * Record the Conversation's identity and notify on any change.
     * @param sessionId - session identity from the probe, or null when gone.
     */
    function reportSession(sessionId) {
      const next = sessionId === undefined || sessionId === null ? null : String(sessionId);
      if (next === activeSessionId) return;
      activeSessionId = next;
      for (const listener of [...sessionChangeListeners]) listener();
    }

    /**
     * Draws nothing. Registered into a session-scoped slot for two documented
     * reasons: the slot system disposes it when this Session's Conversation goes
     * away, and this slot's props carry `sessionId` — the identity the
     * root-scoped overlay cannot see.
     * @param props - slot props; `sessionId` per the slot catalog, with
     *   `session.id` as the owner-prop fallback.
     * @returns always null.
     */
    function SessionScopeProbe(props) {
      const sessionId = props === undefined || props === null
        ? undefined
        : props.sessionId ?? props.session?.id;
      useEffect(() => {
        reportSession(sessionId);
        return () => reportSession(null);
      }, [sessionId]);
      return null;
    }

    /** The overlay: the right-click menu, explanation cards, collapsed chips. */
    function ExplainOverlay() {
      /** Open right-click menu, or null. Carries the selection it was opened for. */
      const [menu, setMenu] = useState(null);
      /** Transient "已复制" feedback for the copy entry. */
      const [copied, setCopied] = useState(false);
      const [cards, setCards] = useState([]);
      /** Active card drag, or null. Carries the live box and the pointer origin. */
      const [drag, setDrag] = useState(null);
      const [, bumpAnchor] = useState(0);
      const idRef = useRef(0);
      const frameRef = useRef(0);
      const cardsRef = useRef(cards);
      cardsRef.current = cards;
      /**
       * The active drag. Written by the pointer handlers and read by them, never
       * assigned during render: pointer events are native, so at the moment a
       * `pointerup` arrives React may not have committed the latest state yet, and
       * a render-synced ref would make the handler read `null` and return — leaving
       * `drag` stuck and every later drag ignored.
       */
      const dragRef = useRef(null);
      /**
       * Anchor rectangles this render actually placed each card against. The
       * post-commit pass compares them with what the committed DOM reports, which
       * is how a nested card's one-commit lag is detected and closed.
       */
      const placedRectsRef = useRef(new Map());
      /** Streamed text per card, flushed at most once per animation frame. */
      const pendingRef = useRef(new Map());
      const deltaFrameRef = useRef(0);

      /**
       * Replace one card through an updater.
       * @param id - card id.
       * @param update - pure updater receiving the current record.
       */
      const patchCard = useCallback((id, update) => {
        setCards((current) => current.map((card) => (card.id === id ? update(card) : card)));
      }, []);

      /**
       * Start dragging a card by its handle.
       *
       * The origin is taken from the card's measured box rather than from its
       * style: a card placed by the flip/clamp path carries `bottom` instead of
       * `top`, and pinning from the style would make it jump on the first move.
       *
       * `dragRef` is written here, synchronously, so a pointerup that arrives
       * before React commits this state still finds the gesture.
       * @param event - the pointerdown on the drag handle.
       * @param card - the card being moved.
       */
      const beginDrag = useCallback((event, card) => {
        if (event.button !== 0) return;
        const element = event.currentTarget.closest(`[${CARD_ATTR}]`);
        const box = element === null ? null : element.getBoundingClientRect();
        const left = box === null ? 8 : box.left;
        const top = box === null ? 8 : box.top;
        const next = {
          id: card.id,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originLeft: left,
          originTop: top,
          left,
          top,
          width: box === null ? CARD_WIDTH : box.width,
          height: box === null ? 120 : box.height,
          moved: false,
        };
        dragRef.current = next;
        setDrag(next);
      }, []);

      /**
       * Follow an active drag on the document rather than capturing the pointer.
       *
       * Pointer capture looks tidier, but it retargets the compatibility mouse
       * events, and the `click` that follows is then delivered to the capture
       * element — so any button inside the capture target stops working. Tracking
       * globally keeps the click path untouched.
       *
       * The `moved` threshold also decides whether this gesture is a drag at all:
       * a press that never moves must leave the card anchored, not pin it where it
       * happened to be.
       */
      useEffect(() => {
        const onMove = (event) => {
          const current = dragRef.current;
          if (current === null || current.pointerId !== event.pointerId) return;
          const moved = current.moved
            || Math.abs(event.clientX - current.startX) > 3
            || Math.abs(event.clientY - current.startY) > 3;
          // Only once it is a real drag: stopping the default on pointerdown would
          // suppress the click, but on pointermove it is harmless and keeps the
          // browser from selecting text under the card.
          if (moved) event.preventDefault();
          const next = {
            ...current,
            moved,
            left: clamp(
              current.originLeft + (event.clientX - current.startX),
              48 - current.width,
              window.innerWidth - 48,
            ),
            top: clamp(
              current.originTop + (event.clientY - current.startY),
              0,
              window.innerHeight - 32,
            ),
          };
          dragRef.current = next;
          setDrag(next);
        };

        const onUp = (event) => {
          const current = dragRef.current;
          if (current === null || current.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (current.moved) {
            patchCard(current.id, (card) => ({ ...card, pinned: { left: current.left, top: current.top } }));
          }
          setDrag(null);
        };

        const onLostWindow = () => {
          dragRef.current = null;
          setDrag(null);
        };

        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
        // Insurance: a release outside the window can miss every pointer event,
        // and a drag left active would swallow every later gesture.
        window.addEventListener('blur', onLostWindow);
        return () => {
          document.removeEventListener('pointermove', onMove, true);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('pointercancel', onUp, true);
          window.removeEventListener('blur', onLostWindow);
        };
      }, [patchCard]);

      /**
       * Drop a card's pinned position and let it follow its text again.
       * @param id - card id.
       */
      const unpinCard = useCallback((id) => {
        patchCard(id, (card) => {
          if (card.pinned === undefined) return card;
          const next = { ...card };
          delete next.pinned;
          return next;
        });
      }, [patchCard]);

      /**
       * Apply every buffered delta in one state update.
       *
       * Streaming used to commit per token: each commit re-rendered the overlay
       * and re-read layout for every open card, so a fast stream with several
       * cards was one forced layout per token. Batching to one update per frame
       * keeps rendering on the browser's own schedule.
       */
      const flushDeltas = useCallback(() => {
        if (deltaFrameRef.current !== 0) {
          window.cancelAnimationFrame(deltaFrameRef.current);
          deltaFrameRef.current = 0;
        }
        const buffered = pendingRef.current;
        if (buffered.size === 0) return;
        pendingRef.current = new Map();
        setCards((current) => current.map((card) => {
          const addition = buffered.get(card.id);
          return addition === undefined ? card : { ...card, content: card.content + addition };
        }));
      }, []);

      /**
       * Buffer one streamed delta for the next frame.
       * @param id - card id.
       * @param text - the delta text.
       */
      const queueDelta = useCallback((id, text) => {
        pendingRef.current.set(id, (pendingRef.current.get(id) ?? '') + text);
        if (deltaFrameRef.current !== 0) return;
        deltaFrameRef.current = window.requestAnimationFrame(() => {
          deltaFrameRef.current = 0;
          flushDeltas();
        });
      }, [flushDeltas]);

      /**
       * Ask the Host to explain one fragment and stream the answer into a new card.
       * @param text - the fragment to explain.
       * @param range - the selected Range, kept so the card can follow its anchor.
       * @param rect - the rectangle captured at selection time.
       * @param parent - the enclosing card's `{ term, content }` for a nested
       *   lookup, else null. A nested lookup needs no DOM read: the parent
       *   explanation already states the sense the term carries here.
       */
      const explain = useCallback((text, range, rect, parent) => {
        idRef.current += 1;
        const id = `explain-${idRef.current}`;
        const context = parent === null ? contextWindow(range) : parent.content;
        const parentTerm = parent === null ? '' : parent.term;
        // Recorded here, once, rather than re-derived from the DOM on every render.
        // A nested card's anchor lives inside its parent's body, and that body is
        // *unmounted* whenever the parent is minimized or closed — at which point a
        // DOM lookup from the anchor either walks a detached tree or finds nothing.
        // The containment this card was created with is the durable fact.
        const parentId = parent === null ? null : parent.id;
        // What we attached, and whether the Host half confirmed receiving it.
        // A Host half installed before this feature answers anyway and simply
        // drops the extra fields, so the card must be able to say so.
        const attached = {
          contextChars: context.length,
          parentChars: parentTerm.length,
          parentTermText: parentTerm,
          hostConfirmed: false,
        };
        // Context is part of the identity: the same word in two sentences must
        // not share one cached answer.
        const key = cacheKey(`${text}\u0000${context}\u0000${parentTerm}`);
        setMenu(null);
        setCopied(false);
        // Hand the text over to our own marker: clearing the native selection
        // makes the marker immediately visible instead of hiding under it.
        window.getSelection()?.removeAllRanges();

        const cached = answerCache.get(key);
        if (cached !== undefined) {
          // Instant: a fragment we already explained costs no request and no tokens.
          setCards((current) => [
            ...current,
            {
              id,
              text,
              range,
              rect,
              parentId,
              content: cached,
              status: 'done',
              error: null,
              collapsed: false,
              controller: new AbortController(),
              colorIndex: pickColorIndex(current),
              ...attached,
            },
          ]);
          return;
        }

        const controller = new AbortController();
        setCards((current) => [
          ...current,
          {
            id,
            text,
            range,
            rect,
            parentId,
            content: '',
            status: 'loading',
            error: null,
            collapsed: false,
            controller,
            colorIndex: pickColorIndex(current),
            ...attached,
          },
        ]);

        void (async () => {
          // Accumulated locally so the cache is written outside a state updater.
          let answer = '';
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text, context, parent: parentTerm }),
              signal: controller.signal,
            });

            if (!response.ok) {
              const detail = await response.text().catch(() => '');
              let message = `HTTP ${response.status}`;
              try {
                const parsed = JSON.parse(detail.trim());
                if (parsed !== null && typeof parsed.error === 'string') message = parsed.error;
              } catch {
                if (detail.trim().length > 0) message = `${message}: ${detail.trim()}`;
              }
              throw new Error(message);
            }
            if (response.body === null) throw new Error('响应无法流式读取。');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let failed = false;

            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let newline = buffer.indexOf('\n');
              while (newline >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (line.length === 0) continue;

                let event;
                try {
                  event = JSON.parse(line);
                } catch {
                  continue;
                }
                if (event !== null && event.type === 'meta') {
                  // The Host half is current: it saw the context fields.
                  patchCard(id, (card) => ({ ...card, hostConfirmed: true }));
                } else if (event !== null && event.type === 'delta' && typeof event.text === 'string') {
                  answer += event.text;
                  queueDelta(id, event.text);
                } else if (event !== null && event.type === 'error') {
                  failed = true;
                  // Settle the text already streamed before flipping the status,
                  // or the last buffered frame would be dropped.
                  flushDeltas();
                  patchCard(id, (card) => ({
                    ...card,
                    status: 'error',
                    error: typeof event.message === 'string' ? event.message : '模型调用失败。',
                  }));
                }
              }
            }

            // Only a clean, complete answer is worth remembering.
            flushDeltas();
            if (!failed) remember(key, answer);
            patchCard(id, (card) => (card.status === 'error' ? card : { ...card, status: 'done' }));
          } catch (error) {
            flushDeltas();
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
              patchCard(id, (card) => ({ ...card, status: 'done' }));
              return;
            }
            patchCard(id, (card) => ({
              ...card,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        })();
      }, [patchCard, queueDelta, flushDeltas]);

      /**
       * Explain a term the model marked inside a card, anchored to that term.
       * @param term - the marked term.
       * @param element - the rendered span.
       */
      const explainTerm = useCallback((card, term, element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        let rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) rect = element.getBoundingClientRect();
        explain(term, range, rect, { id: card.id, term: card.text, content: card.content });
      }, [explain]);

      // Right-click is the only trigger; selecting text alone pops nothing.
      useEffect(() => {
        const onContextMenu = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(`[${CONTROL}]`) !== null) {
            // Our own menu and cards keep their own behaviour.
            event.preventDefault();
            return;
          }
          // Editable fields and empty selections fall through to the Host's
          // native menu, which is where undo/cut/paste/select-all live.
          const selection = readSelection();
          if (selection === null) return;

          event.preventDefault();
          // Resolve the enclosing card through the ref: this listener is
          // installed once, so the state it closed over would be stale.
          const parent = selection.parentId === null
            ? null
            : cardsRef.current.find((card) => card.id === selection.parentId) ?? null;
          setCopied(false);
          setMenu({
            x: event.clientX,
            y: event.clientY,
            text: selection.text,
            range: selection.range,
            rect: selection.rect,
            parent: parent === null ? null : { id: parent.id, term: parent.text, content: parent.content },
          });
        };

        // A context menu is transient: any press outside, scroll, resize or
        // Escape closes it, exactly like the native one.
        const onMouseDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(`[${CONTROL}]`) !== null) return;
          setMenu(null);
        };

        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          setMenu(null);
        };

        // Cards follow their anchor while the page scrolls or resizes.
        const onViewportChange = () => {
          setMenu(null);
          if (frameRef.current !== 0) return;
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = 0;
            bumpAnchor((value) => value + 1);
          });
        };

        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);

        return () => {
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('mousedown', onMouseDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('scroll', onViewportChange, true);
          window.removeEventListener('resize', onViewportChange);
          if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current);
        };
      }, []);

      // Keep the registry markers exactly in sync with the cards: a card
      // appearing marks its fragment, and closing that card is what unmarks it.
      // Collapsing keeps the card (and therefore its marker) alive.
      useEffect(() => {
        if (!supportsHighlight) return;
        const live = new Set();
        for (const card of cards) {
          // Card ids already carry the marker prefix, so they double as registry names.
          const name = card.id;
          live.add(name);
          if (CSS.highlights.has(name)) continue;
          CSS.highlights.set(name, new Highlight(card.range));
        }
        for (const name of [...CSS.highlights.keys()]) {
          if (!name.startsWith(HIGHLIGHT_PREFIX) || live.has(name)) continue;
          CSS.highlights.delete(name);
        }
      }, [cards]);

      /**
       * Close the one-commit lag on nested cards.
       *
       * A card anchored inside another card measures its anchor with
       * `getBoundingClientRect()` while React renders — and rendering happens
       * *before* the DOM changes. So in the commit where the parent moves, the child
       * still measures the parent's previous geometry and ends up parked where the
       * parent used to be. It only catches up when something unrelated re-renders
       * (a scroll, a resize), which is exactly the "follows only after scrolling"
       * symptom.
       *
       * This runs after every commit and compares the rectangles the render placed
       * against with what the committed DOM now reports; if anything moved it
       * renders once more, and that pass sees the settled geometry. `useLayoutEffect`
       * runs before paint, so the extra pass is never visible as a flicker.
       *
       * Parked cards are skipped: their position does not depend on their anchor, so
       * there is nothing to catch up on. The loop terminates because the second pass
       * finds the rectangles equal.
       */
      useLayoutEffect(() => {
        const placed = placedRectsRef.current;
        const dragging = dragRef.current;
        let stale = false;
        for (const card of cards) {
          if (card.pinned !== undefined) continue;
          if (dragging !== null && dragging.id === card.id) continue;
          const before = placed.get(card.id);
          if (before === undefined) continue;
          const now = anchorRect(card.range, card.rect);
          if (
            Math.abs(now.left - before.left) > 0.5
            || Math.abs(now.top - before.top) > 0.5
            || Math.abs(now.width - before.width) > 0.5
            || Math.abs(now.height - before.height) > 0.5
          ) {
            stale = true;
            break;
          }
        }
        if (stale) bumpAnchor((value) => value + 1);
      });

      // Destroy everything the moment this Session's Conversation changes or goes
      // away. Cards are scoped to the reading session: they are used once and
      // thrown away, never carried into another Session and never retained.
      useEffect(() => {
        const listener = () => {
          if (deltaFrameRef.current !== 0) {
            window.cancelAnimationFrame(deltaFrameRef.current);
            deltaFrameRef.current = 0;
          }
          pendingRef.current = new Map();
          for (const card of cardsRef.current) card.controller.abort();
          setCards([]);
          setMenu(null);
          setCopied(false);
        };
        sessionChangeListeners.add(listener);
        return () => {
          sessionChangeListeners.delete(listener);
        };
      }, []);

      // Abort in-flight model calls, drop buffered frames, and remove every
      // marker we own on unmount.
      useEffect(() => () => {
        if (deltaFrameRef.current !== 0) {
          window.cancelAnimationFrame(deltaFrameRef.current);
          deltaFrameRef.current = 0;
        }
        pendingRef.current = new Map();
        for (const card of cardsRef.current) card.controller.abort();
        if (!supportsHighlight) return;
        for (const name of [...CSS.highlights.keys()]) {
          if (name.startsWith(HIGHLIGHT_PREFIX)) CSS.highlights.delete(name);
        }
      }, []);

      // `::highlight()` rules are static CSS keyed by name, so they render with
      // the component; unmounting the slot entry removes them with it.
      const markerCss = supportsHighlight
        ? cards
          .map((card) => `::highlight(${card.id}){background-color:${MARKER_COLORS[card.colorIndex % MARKER_COLORS.length]};}`)
          .join('')
        : '';

      // Orphan guard, independent of the session signal: a card must never stay
      // pinned to text that no longer exists (fork, workspace switch, panel
      // teardown). Conditional state adjustment during render is the documented
      // pattern here — React re-renders before committing, so an orphan can never
      // reach the screen.
      //
      // Only an all-orphan set is pruned: a single detached anchor can happen
      // transiently while React swaps nodes, and deleting one card the user is
      // mid-read on would be worse than briefly reusing its last position.
      if (cards.length > 0 && !cards.some(isAnchored)) {
        setCards((current) => current.filter(isAnchored));
      }

      const children = [];

      // Which card each card's anchor lives inside, and what that implies.
      //
      // Taken from the record written at creation time, not re-derived from the DOM:
      // the anchor of a nested card sits inside its parent's body, and that body is
      // unmounted the moment the parent is minimized or closed, so a DOM lookup is
      // exactly what breaks in the cases this has to decide. The DOM lookup survives
      // only as a fallback for a record that somehow lacks the field.
      const parentIds = new Map();
      for (const card of cards) {
        parentIds.set(card.id, card.parentId === undefined ? parentIdOf(card) : card.parentId);
      }
      const anchorsInside = new Set([...parentIds.values()].filter((id) => id !== null));
      const collapsedIds = new Set(cards.filter((card) => card.collapsed).map((card) => card.id));

      // A card whose anchor lives inside a minimized ancestor has nothing on screen
      // to sit beside, so it is not drawn — but it stays in state, and because the
      // ancestor keeps its body mounted (below) its Range survives, so it returns to
      // the right place when the ancestor is expanded again.
      //
      // This is decided purely by where the anchor is, never by whether the card is
      // parked. Following and existing are separate rules: a parked card does not
      // follow its anchor's position, but it has no anchor on screen either, so it
      // has no business still floating there. Exempting parked cards made a nested
      // card outlive the very text it explains.
      const hiddenIds = new Set();
      for (const card of cards) {
        let ancestor = parentIds.get(card.id);
        for (let depth = 0; ancestor !== undefined && ancestor !== null && depth < 32; depth += 1) {
          if (collapsedIds.has(ancestor)) {
            hiddenIds.add(card.id);
            break;
          }
          ancestor = parentIds.get(ancestor);
        }
      }

      // Cascade a closure: whatever was anchored inside a card dies with it.
      //
      // Closing a card removes it from state, which detaches every Range that pointed
      // into its body. The orphan guard below cannot be relied on for this — it only
      // prunes when *every* card is an orphan, so one surviving top-level card was
      // enough to leave a nested card behind as a ghost, still drawn, with its tether
      // pointing at empty space.
      //
      // This is decided structurally instead of by detachedness: walk each card's
      // recorded containment chain and prune it if any ancestor is no longer in state.
      // That is deterministic, needs no extra render to notice, and is transitively
      // complete in one pass — a grandchild is caught because its parent is still
      // present while its grandparent is already gone.
      const presentIds = new Set(cards.map((card) => card.id));
      const doomedIds = new Set();
      for (const card of cards) {
        let ancestor = parentIds.get(card.id);
        for (let depth = 0; ancestor !== undefined && ancestor !== null && depth < 32; depth += 1) {
          if (!presentIds.has(ancestor)) {
            doomedIds.add(card.id);
            break;
          }
          ancestor = parentIds.get(ancestor);
        }
      }
      if (doomedIds.size > 0) {
        setCards((current) => current.filter((card) => !doomedIds.has(card.id)));
      }

      // Rebuilt every render, so a card removed from state simply stops appearing.
      placedRectsRef.current.clear();

      for (const card of cards) {
        const visible = !hiddenIds.has(card.id);
        // Anything anchored inside this card needs its body's text nodes to survive,
        // whether the card is minimized by the user or hidden by an ancestor's
        // collapse. Only guarding the minimized case left the second level of a
        // three-level nest unmounted, which killed the third level's anchor.
        const keepsBody = anchorsInside.has(card.id);
        // Nothing to show and nothing nested to preserve.
        if (!visible && !keepsBody) continue;

        const rect = anchorRect(card.range, card.rect);
        placedRectsRef.current.set(card.id, rect);

        // The chip always sits on its text. It used to inherit the card's parked
        // position, so minimizing a card you had dragged stranded the chip wherever
        // the card had been — the one thing a minimized marker must not do.
        //
        // A card hidden by an ancestor gets no chip at all: its anchor is not on
        // screen either, so there is nothing for a marker to mark.
        const chip = visible && card.collapsed
          ? h(
            'button',
            {
              // Never `card.id`: that key belongs to the card node itself, and the
              // two must be distinct so React can keep the card's DOM alive (see the
              // minimized-with-children branch below).
              key: `${card.id}-chip`,
              type: 'button',
              style: { ...chipStyle, ...placeChipBeside(rect) },
              [CONTROL]: 'chip',
              title: '展开解释卡片',
              onClick: () => patchCard(card.id, (current) => ({ ...current, collapsed: false })),
            },
            h(
              'span',
              { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `解释：${stripMarkers(card.text)}`,
            ),
            h('span', { 'aria-hidden': true }, '▸'),
          )
          : null;

        // Minimized with nothing nested inside: the chip is the whole story and the
        // body is genuinely gone, so nothing expensive is built.
        const drawNode = (visible && !card.collapsed) || keepsBody;
        if (!drawNode) {
          children.push(chip);
          continue;
        }

        // Card positions, in priority order: the live drag, a parked position the
        // user chose, or the anchor itself.
        const live = drag !== null && drag.id === card.id ? drag : null;
        const box = live !== null
          ? { left: `${live.left}px`, top: `${live.top}px` }
          : card.pinned !== undefined
            ? { left: `${card.pinned.left}px`, top: `${card.pinned.top}px` }
            : null;

        const head = h(
          'div',
          { style: headStyle },
          // The handle owns the whole left side (grip + term). The buttons are its
          // siblings, so pressing one never enters the drag path.
          h(
            'div',
            {
              style: dragHandleStyle,
              [CONTROL]: 'card-handle',
              title: '拖动移动卡片，双击回到原文',
              onPointerDown: (event) => beginDrag(event, card),
              onDoubleClick: () => unpinCard(card.id),
            },
            h('span', { style: gripStyle, 'aria-hidden': true }, '⣿'),
            h('span', { style: termStyle, title: card.text }, stripMarkers(card.text)),
          ),
          // Only reachable state that needs an escape hatch: a card the user
          // parked. Discoverable, and independent of dblclick firing.
          card.pinned === undefined
            ? null
            : h('button', {
              type: 'button',
              style: iconButtonStyle,
              [CONTROL]: 'unpin',
              title: '回到原文',
              onClick: () => unpinCard(card.id),
            }, '⤺'),
          h('button', {
            type: 'button',
            style: iconButtonStyle,
            [CONTROL]: 'collapse',
            title: '收起卡片（回到原文处）',
            onClick: () => patchCard(card.id, (current) => {
              const next = { ...current, collapsed: true };
              // Minimizing means "put it back": dropping the parked position here
              // keeps the chip and the card expanded out of it in the same place —
              // on the words — instead of the chip sitting on the text while the
              // card reappears where it was dragged to.
              delete next.pinned;
              return next;
            }),
          }, '–'),
          h('button', {
            type: 'button',
            style: iconButtonStyle,
            [CONTROL]: 'close',
            title: '关闭卡片',
            onClick: () => {
              card.controller.abort();
              setCards((current) => current.filter((item) => item.id !== card.id));
            },
          }, '×'),
        );

        let status = null;
        if (card.status === 'loading') status = h('div', { style: statusStyle }, '正在解释…');
        else if (card.status === 'error') {
          status = h(
            'div',
            { style: { ...statusStyle, color: 'var(--dsw-alias-state-error-primary)' } },
            card.error,
          );
        }

        // Say what disambiguation was attached. A Host half older than this
        // feature accepts the request and silently drops the extra fields, so
        // "context arrived" and "context was ignored" must look different.
        let provenance = null;
        if (card.contextChars > 0 || card.parentChars > 0) {
          const parts = [];
          if (card.parentChars > 0) parts.push(`父术语「${card.parentTermText}」`);
          if (card.contextChars > 0) parts.push(`上下文 ${card.contextChars} 字`);
          const detail = parts.length === 0 ? '' : `（${parts.join(' + ')}）`;
          provenance = h(
            'div',
            { style: provenanceStyle },
            card.hostConfirmed ? `已带上下文${detail}` : `已带上下文${detail} · 宿主未确认，请重启应用`,
          );
        }

        // Deliberately NOT marked as a control: the card body must accept text
        // selections, which is the entire nesting path.
        const body = h(
          'div',
          { style: bodyStyle },
          renderContent(card.content, (term, element) => explainTerm(card, term, element)),
        );

        // Visible in full: the ordinary case.
        if (visible && !card.collapsed) {
          children.push(
            h(
              'div',
              {
                key: card.id,
                // The dragged card lifts above its neighbours so it is never
                // dragged *under* another card.
                //
                // It also stops hit-testing while held. This overlay lives above
                // every column and *outside* their scroll containers, so a wheel
                // over the card would chain up the overlay's own ancestors to the
                // frame and never reach the transcript. Letting the pointer fall
                // through puts the wheel back on whatever is underneath — the
                // transcript scrolls natively, and a card can be repositioned over
                // content that is currently off-screen. The gesture is tracked on
                // the document, so the card needs no pointer events to stay draggable.
                style: {
                  ...cardStyle,
                  ...(box ?? placeBeside(rect, CARD_WIDTH, 220)),
                  ...(live === null ? null : { zIndex: 5, pointerEvents: 'none' }),
                },
                [CARD_ATTR]: card.id,
              },
              head,
              body,
              status,
              provenance,
            ),
          );
          continue;
        }

        // Kept mounted but invisible: either minimized by the user, or hidden because
        // an ancestor was minimized. This runs for any card with something anchored
        // inside it, at every level — unmounting the body detaches those Ranges for
        // good, since expanding again builds *fresh* text nodes and a nested card
        // could never re-anchor. It would sit frozen at a stale rectangle, its
        // highlight gone.
        //
        // The card node keeps its *own* key (`card.id`) and position in the list. That
        // is the whole point: React matches keyed children by key and moves the
        // existing DOM node instead of rebuilding it, so the text nodes a nested Range
        // points at survive the cycle. `visibility: hidden` still reports real
        // geometry, so those anchors stay measurable and land correctly on return.
        if (chip !== null) children.push(chip);
        children.push(
          h(
            'div',
            {
              key: card.id,
              style: {
                ...cardStyle,
                ...(box ?? placeBeside(rect, CARD_WIDTH, 220)),
                visibility: 'hidden',
                pointerEvents: 'none',
                zIndex: 1,
              },
              [CARD_ATTR]: card.id,
            },
            head,
            body,
            status,
            provenance,
          ),
        );
      }

      if (menu !== null) {
        // Anchored to the pointer, clamped so the menu never leaves the frame.
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const menuWidth = 148;
        const menuHeight = 78;
        children.push(
          h(
            'div',
            {
              key: 'context-menu',
              role: 'menu',
              style: {
                ...menuStyle,
                left: `${Math.min(Math.max(8, menu.x), Math.max(8, viewportWidth - menuWidth - 8))}px`,
                top: `${Math.min(Math.max(8, menu.y), Math.max(8, viewportHeight - menuHeight - 8))}px`,
              },
              [CONTROL]: 'menu',
              // Our own menu never opens a menu.
              onContextMenu: (event) => event.preventDefault(),
            },
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: MENU_ITEM_CLASS,
                style: menuItemStyle,
                [CONTROL]: 'menu-explain',
                // Keep the native selection alive through the click.
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  const request = menu;
                  setMenu(null);
                  explain(request.text, request.range, request.rect, request.parent);
                },
              },
              '解释',
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: MENU_ITEM_CLASS,
                style: menuItemStyle,
                [CONTROL]: 'menu-copy',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  const request = menu;
                  void copyText(request.text).then((ok) => {
                    if (!ok) {
                      console.error('explain-selection: copy failed');
                      setMenu(null);
                      return;
                    }
                    setCopied(true);
                    window.setTimeout(() => {
                      setMenu(null);
                      setCopied(false);
                    }, 600);
                  });
                },
              },
              copied ? '已复制' : '复制',
            ),
          ),
        );
      }

      // The tether: while a card is being dragged, draw a faint dashed line from
      // it back to the exact words it explains.
      //
      // Nested cards need no special handling. A nested card's Range points at the
      // term span *inside its parent card*, so when the parent is dragged the DOM
      // moves and `getBoundingClientRect()` follows — the tether retargets itself.
      // The same is true when the parent is itself pinned somewhere else.
      let tether = null;
      if (drag !== null && drag.moved) {
        const dragged = cards.find((card) => card.id === drag.id);
        // Only tether to text that still exists: an orphan's captured rectangle is
        // a stale viewport coordinate, and a line to nowhere is worse than none.
        if (dragged !== undefined && isAnchored(dragged)) {
          const target = anchorRect(dragged.range, dragged.rect);
          const cardBox = { left: drag.left, top: drag.top, width: drag.width, height: drag.height };
          const cardCenter = { x: cardBox.left + cardBox.width / 2, y: cardBox.top + cardBox.height / 2 };
          const targetCenter = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
          const from = edgePoint(cardBox, targetCenter);
          const to = edgePoint(target, cardCenter);
          tether = h(
            'svg',
            { key: 'drag-tether', style: dragLayerStyle, 'aria-hidden': true },
            h('line', {
              x1: from.x,
              y1: from.y,
              x2: to.x,
              y2: to.y,
              stroke: TETHER_STROKE,
              strokeWidth: 1,
              strokeDasharray: '5 4',
              strokeOpacity: TETHER_OPACITY,
            }),
            // A dot marks exactly which words the card belongs to.
            h('circle', {
              cx: to.x,
              cy: to.y,
              r: 2.5,
              fill: TETHER_STROKE,
              fillOpacity: TETHER_OPACITY,
            }),
          );
        }
      }

      return h(
        'div',
        { style: { position: 'fixed', inset: 0, zIndex: 30, pointerEvents: 'none', fontFamily: 'inherit' } },
        [
          h('style', {
            key: 'overlay-styles',
            // Static menu rules plus the per-card marker rules; both live and die
            // with this slot entry.
            dangerouslySetInnerHTML: { __html: `${MENU_CSS}${markerCss}` },
          }),
          tether,
          ...children,
        ],
      );
    }

    return {
      // `slots` is a hard dependency: without it `ctx.slots` is unavailable and
      // the registrations below would fail silently.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'explain-selection', order: 40 },
          ExplainOverlay,
        ));
        // A session-scoped registration beside the frame-wide overlay. It draws
        // nothing: it exists because THIS slot's props carry the Session
        // identity, and because the slot system disposes it when the anchored
        // Conversation goes away. See SessionScopeProbe.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'explain-selection-session', order: 900 },
          SessionScopeProbe,
        ));
      },
    };
  },
});
