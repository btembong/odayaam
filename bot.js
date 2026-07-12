'use strict';

/**
 * bot.js — conversation finite state machine (FSM)
 *
 * Every incoming message is interpreted relative to `session.step`.
 * The FSM shape mirrors USSD/IVR menus: all interaction is numeric, which
 * means this backend could sit behind an SMS/USSD gateway or WhatsApp Business
 * webhook with zero changes here.
 *
 * ── State diagram ────────────────────────────────────────────────────────────
 *
 *  MAIN
 *   └─ 1 ──▶ BROWSE_CATEGORIES
 *              └─ <n> ──▶ BROWSE_ITEMS
 *                          └─ <n> ──▶ SELECT_VARIANT  (if item has variants)
 *                                      └─ <n> ──▶ SELECT_ADDONS  (if addons)
 *                                                  └─ <n|0> ──▶ ENTER_QUANTITY
 *                                                               └─ <n> ──▶ ITEM_ADDED
 *   └─ 2 ──▶ VIEW_CART
 *   └─ 99 ─▶ CHECKOUT_CONFIRM
 *              └─ 1 ──▶ AWAITING_PAYMENT  (TranZak payment link issued)
 *              └─ 2 ──▶ SCHEDULE_DATETIME ──▶ AWAITING_PAYMENT
 *              └─ 3 ──▶ COLLECT_CUSTOMER_INFO ──▶ CHECKOUT_CONFIRM
 *   └─ 98 ─▶ ORDER_HISTORY
 *              └─ <n> ─▶ ORDER_DETAIL
 *   └─ 97 ─▶ (render current order inline, no step change)
 *   └─ 0  ─▶ CANCEL_CONFIRM ──▶ MAIN (confirmed) | prev step (declined)
 *
 * ── Global shortcuts ─────────────────────────────────────────────────────────
 *   0   → cancel confirm (or back to MAIN if nothing to cancel)
 *   1   → place an order (BROWSE_CATEGORIES) — excluded mid-flow (see handleMessage)
 *   97  → current order
 *   98  → order history
 *   99  → checkout
 */

const menu = require('./menu');
const { getSession, saveSession } = require('./db');
const { createPaymentRequest } = require('./tranzak');
const { v4: uuidv4 } = require('uuid');

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(amount) {
  return `${Number(amount).toLocaleString()} XAF`;
}

function cartTotal(cart) {
  return cart.reduce((sum, e) => sum + e.totalPrice, 0);
}

function divider() {
  return '─'.repeat(30);
}

// ─── Screen renderers ─────────────────────────────────────────────────────────

function renderMain(session) {
  const count = session.cart.length;
  const cartNote = count > 0
    ? `\nCart: ${count} item${count !== 1 ? 's' : ''} — ${fmt(cartTotal(session.cart))}`
    : '';
  return {
    reply: [
      'Welcome to *Odayam Restaurant*',
      divider(),
      '1.  Place an order',
      '2.  View / Edit cart',
      '99. Checkout',
      '98. Order history',
      '97. Current order',
      '0.  Cancel order',
      divider() + cartNote,
    ].join('\n'),
    quickReplies: ['1. Place an order', '2. View cart', '99. Checkout', '98. Order history', '97. Current order', '0. Cancel'],
  };
}

function renderCategories() {
  const cats = menu.getCategories();
  const lines = cats.map((c, i) => `${i + 1}. ${c.name}`);
  return {
    reply: [
      '*Select a category:*',
      divider(),
      ...lines,
      divider(),
      '0. Main menu',
    ].join('\n'),
    quickReplies: [...lines, '0. Main menu'],
  };
}

function renderItems(categoryId) {
  const cat   = menu.getCategory(categoryId);
  const items = menu.getItemsByCategory(categoryId);
  const lines = items.map((item, i) => {
    const price = item.variants.length > 0
      ? `from ${fmt(Math.min(...item.variants.map(v => v.price)))}`
      : fmt(item.price);
    return `${i + 1}. ${item.name}  —  ${price}`;
  });
  return {
    reply: [`*${cat.name}*`, divider(), ...lines, divider(), '0. Back'].join('\n'),
    quickReplies: [...items.map((item, i) => `${i + 1}. ${item.name}`), '0. Back'],
  };
}

function renderVariants(item) {
  const lines = item.variants.map((v, i) => `${i + 1}. ${v.label}  —  ${fmt(v.price)}`);
  return {
    reply: [
      `*${item.name}*`,
      item.description,
      divider(),
      'Choose a size / option:',
      ...lines,
      divider(),
      '0. Back',
    ].join('\n'),
    quickReplies: [...item.variants.map((v, i) => `${i + 1}. ${v.label}`), '0. Back'],
  };
}

function renderAddons(item) {
  const lines = item.addons.map((a, i) => `${i + 1}. ${a.label}  +${fmt(a.price)}`);
  return {
    reply: [
      '*Add extras? (optional)*',
      divider(),
      ...lines,
      divider(),
      'Enter numbers separated by commas (e.g. 1,2) or *0* to skip.',
    ].join('\n'),
    quickReplies: [...item.addons.map((a, i) => `${i + 1}. ${a.label}`), '0. Skip'],
  };
}

function renderQuantity(session) {
  const { item, variant, addons } = session.context;
  const addonSum  = (addons || []).reduce((s, a) => s + a.price, 0);
  const unitPrice = (variant ? variant.price : item.price) + addonSum;
  const addonLine = addons && addons.length > 0
    ? `\nExtras: ${addons.map(a => a.label).join(', ')}`
    : '';
  return {
    reply: [
      `*${item.name}*${variant ? ` — ${variant.label}` : ''}${addonLine}`,
      `Unit price: ${fmt(unitPrice)}`,
      divider(),
      'How many would you like? (1–20)',
    ].join('\n'),
    quickReplies: ['1', '2', '3', '5'],
  };
}

function renderItemAdded(entry) {
  return {
    reply: [
      `Added to cart: *${entry.itemName}*${entry.variantLabel ? ` (${entry.variantLabel})` : ''} × ${entry.quantity}`,
      `Subtotal: ${fmt(entry.totalPrice)}`,
      divider(),
      '1. Add more items',
      '2. View cart',
      '99. Checkout',
      '0. Cancel order',
    ].join('\n'),
    quickReplies: ['1. Add more items', '2. View cart', '99. Checkout', '0. Cancel'],
  };
}

function renderCart(session) {
  if (session.cart.length === 0) {
    return {
      reply: ['Your cart is empty.', divider(), '1. Place an order'].join('\n'),
      quickReplies: ['1. Place an order'],
    };
  }
  const lines = session.cart.map((e, i) =>
    `${i + 1}. ${e.itemName}${e.variantLabel ? ` (${e.variantLabel})` : ''} × ${e.quantity}  —  ${fmt(e.totalPrice)}`
  );
  return {
    reply: [
      '*Your cart:*',
      divider(),
      ...lines,
      divider(),
      `Total: *${fmt(cartTotal(session.cart))}*`,
      divider(),
      'Type an item number to remove it.',
      '1. Add more items  |  99. Checkout  |  0. Cancel',
    ].join('\n'),
    quickReplies: ['99. Checkout', '1. Add more items', '0. Cancel'],
  };
}

function renderCheckoutConfirm(session) {
  const lines = session.cart.map(e =>
    `• ${e.itemName}${e.variantLabel ? ` (${e.variantLabel})` : ''} × ${e.quantity}  —  ${fmt(e.totalPrice)}`
  );
  const info = session.customerInfo
    ? `Contact: ${session.customerInfo.name} · ${session.customerInfo.phone}`
    : '3. Add your name & phone number';
  return {
    reply: [
      '*Order Summary*',
      divider(),
      ...lines,
      divider(),
      `Total: *${fmt(cartTotal(session.cart))}*`,
      info,
      divider(),
      '1. Pay now',
      '2. Schedule for later',
      session.customerInfo ? '' : '3. Add contact info',
      '0. Back to cart',
    ].filter(Boolean).join('\n'),
    quickReplies: ['1. Pay now', '2. Schedule for later', '3. Add contact info', '0. Back to cart'],
  };
}

function renderOrderHistory(session) {
  if (!session.orders || session.orders.length === 0) {
    return {
      reply: ['No orders found.', divider(), '1. Place an order'].join('\n'),
      quickReplies: ['1. Place an order'],
    };
  }
  const lines = session.orders.map((o, i) => {
    const date   = new Date(o.createdAt).toLocaleDateString('en-CM', { day: '2-digit', month: 'short', year: 'numeric' });
    const status = o.status === 'paid' ? 'Paid' : o.status === 'cancelled' ? 'Cancelled' : 'Awaiting payment';
    return `${i + 1}. ${o.reference}  ${fmt(o.subtotal)}  [${status}]  ${date}`;
  });
  return {
    reply: ['*Order history:*', divider(), ...lines, divider(), 'Type a number to view order details.', '0. Main menu'].join('\n'),
    quickReplies: [...session.orders.map((_, i) => String(i + 1)), '0. Main menu'],
  };
}

function renderOrderDetail(order) {
  const lines = order.items.map(e =>
    `• ${e.itemName}${e.variantLabel ? ` (${e.variantLabel})` : ''} × ${e.quantity}  —  ${fmt(e.totalPrice)}`
  );
  const status    = order.status === 'paid' ? 'Paid' : order.status === 'cancelled' ? 'Cancelled' : 'Awaiting payment';
  const scheduled = order.scheduledFor ? `\nScheduled for: ${order.scheduledFor}` : '';
  const contact   = order.customerInfo  ? `\nContact: ${order.customerInfo.name} · ${order.customerInfo.phone}` : '';
  return {
    reply: [
      `*Order ${order.reference}*`,
      divider(),
      ...lines,
      divider(),
      `Total: *${fmt(order.subtotal)}*`,
      `Status: ${status}${scheduled}${contact}`,
      divider(),
      '0. Back to history',
    ].join('\n'),
    quickReplies: ['0. Back to history'],
  };
}

function renderCurrentOrder(session) {
  const active = session.orders
    ? [...session.orders].reverse().find(o => o.status === 'placed' || o.status === 'paid')
    : null;

  if (!active) {
    return {
      reply: ['No active order found.', divider(), '1. Place an order'].join('\n'),
      quickReplies: ['1. Place an order'],
    };
  }

  const itemLines = active.items.map(e =>
    `• ${e.itemName}${e.variantLabel ? ` (${e.variantLabel})` : ''} × ${e.quantity}  —  ${fmt(e.totalPrice)}`
  );
  const statusLabel = active.status === 'paid' ? 'Paid' : 'Awaiting payment';
  const scheduleLine = active.scheduledFor ? `\nScheduled for: ${active.scheduledFor}` : '';

  const result = {
    reply: [
      `*Order ${active.reference}*`,
      divider(),
      ...itemLines,
      divider(),
      `Total: *${fmt(active.subtotal)}*`,
      `Status: ${statusLabel}${scheduleLine}`,
    ].join('\n'),
    quickReplies: ['1. Place a new order'],
  };

  if (active.status === 'placed' && active.paymentUrl) {
    result.reply += `\n${divider()}\nTap below to complete payment.`;
    result.paymentUrl = active.paymentUrl;
    result.quickReplies = ['1. Place a new order'];
  }

  return result;
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

/**
 * Convert the session cart into a placed order and request a TranZak payment link.
 * Mutates `session` in place (clears cart, pushes to orders, advances step).
 * The caller is responsible for saving the session after this returns.
 *
 * @param {object} session
 * @param {{ label: string, iso: string } | null} scheduled — null for immediate orders
 * @returns {Promise<{ reply: string, quickReplies: string[], paymentUrl?: string }>}
 */
async function doCheckout(session, scheduled = null) {
  const scheduledFor = scheduled ? scheduled.label : null;
  if (session.cart.length === 0) {
    return { reply: 'No order to place.\n\n1. Place an order', quickReplies: ['1. Place an order'] };
  }

  const reference = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;
  const subtotal  = cartTotal(session.cart);

  let paymentUrl    = null;
  let transactionId = null;
  let paymentError  = null;

  try {
    const result = await createPaymentRequest({
      reference,
      amount:            subtotal,
      description:       `Odayam order ${reference}`,
      callbackUrl:       `${process.env.APP_URL}/api/payment/webhook`,
      returnUrl:         `${process.env.APP_URL}/api/payment/callback?ref=${reference}`,
      mobileWalletNumber: session.customerInfo?.phone || null,
    });
    paymentUrl    = result.paymentUrl;
    transactionId = result.transactionId;
  } catch (err) {
    console.error('[tranzak] createPaymentRequest failed:', err.message);
    paymentError = err.message;
  }

  const order = {
    id:            uuidv4(),
    reference,
    items:         [...session.cart],
    subtotal,
    scheduledFor:  scheduledFor || null,
    scheduledAt:   scheduled ? scheduled.iso : null,
    customerInfo:  session.customerInfo || null,
    status:        'placed',
    paymentUrl,
    transactionId,
    createdAt:     new Date().toISOString(),
  };

  if (!session.orders) session.orders = [];
  session.orders.push(order);
  session.cart    = [];
  session.step    = 'AWAITING_PAYMENT';
  session.context = { orderId: order.id };

  if (paymentError) {
    return {
      reply: [
        `Order placed! Reference: *${reference}*`,
        `Total: *${fmt(subtotal)}*`,
        scheduledFor ? `Scheduled for: ${scheduledFor}` : '',
        divider(),
        'Payment link unavailable right now. Please try again later.',
        '97. View this order',
        '1.  Place a new order',
      ].filter(Boolean).join('\n'),
      quickReplies: ['97. Current order', '1. Place a new order'],
    };
  }

  return {
    reply: [
      'Order placed! Reference: *' + reference + '*',
      `Total: *${fmt(subtotal)}*`,
      scheduledFor ? `Scheduled for: ${scheduledFor}` : '',
      divider(),
      'Tap the button below to pay via MTN MoMo or Orange Money.',
      divider(),
      '1. Place a new order',
    ].filter(Boolean).join('\n'),
    quickReplies: ['1. Place a new order'],
    paymentUrl,
  };
}

// ─── Cancel order ─────────────────────────────────────────────────────────────

/**
 * Clear the cart and cancel the most recent unpaid placed order (if any).
 * Resets step to MAIN. Mutates session in place.
 *
 * @param {object} session
 * @returns {{ reply: string, quickReplies: string[] }}
 */
function doCancel(session) {
  const hadCart = session.cart.length > 0;
  session.cart = [];

  // Also cancel the most recent unpaid placed order
  const active = session.orders
    ? session.orders.find(o => o.status === 'placed')
    : null;
  if (active) active.status = 'cancelled';

  session.step    = 'MAIN';
  session.context = {};

  const msg = hadCart || active ? 'Order cancelled.' : 'No active order to cancel.';
  return { reply: msg + '\n\n' + renderMain(session).reply, quickReplies: renderMain(session).quickReplies };
}

// ─── Schedule datetime step ───────────────────────────────────────────────────

function renderSchedule() {
  return {
    reply: [
      '*Schedule your order*',
      divider(),
      'Enter date and time in this format:',
      'DD/MM HH:MM',
      'Example: 25/07 19:30',
      divider(),
      '0. Skip (pay now instead)',
    ].join('\n'),
    quickReplies: ['0. Skip'],
  };
}

// ─── Main message handler ─────────────────────────────────────────────────────

/**
 * Entry point for every chat message. Loads the session, applies global
 * shortcuts first, then delegates to the per-step switch.
 * Always saves the session before returning (except early-return shortcuts
 * which save themselves before returning).
 *
 * @param {string} sessionId — UUID from the rc_session cookie
 * @param {string} text      — raw message text from the customer
 * @returns {Promise<{ reply: string, quickReplies: string[], paymentUrl?: string }>}
 */
async function handleMessage(sessionId, text) {
  const session = await getSession(sessionId);
  const input   = (text || '').trim();

  // ── Global shortcuts ──────────────────────────────────────────────────────
  // These are checked before the step switch so they work from any screen.
  if (input === '0') {
    // In ORDER_DETAIL, 0 goes back to history
    if (session.step === 'ORDER_DETAIL') {
      session.step = 'ORDER_HISTORY';
      await saveSession(session);
      return renderOrderHistory(session);
    }
    // Nothing to cancel — just go home
    if (session.cart.length === 0 && !session.orders?.some(o => o.status === 'placed')) {
      session.step = 'MAIN';
      await saveSession(session);
      return renderMain(session);
    }
    // Ask for confirmation before cancelling
    session.context.prevStep = session.step;
    session.step = 'CANCEL_CONFIRM';
    await saveSession(session);
    return {
      reply: [
        'Are you sure you want to cancel?',
        session.cart.length > 0 ? `This will clear your cart (${session.cart.length} item${session.cart.length !== 1 ? 's' : ''}).` : '',
        divider(),
        '1. Yes, cancel',
        '2. No, go back',
      ].filter(Boolean).join('\n'),
      quickReplies: ['1. Yes, cancel', '2. No, go back'],
    };
  }

  if (input === '97') {
    await saveSession(session);
    return renderCurrentOrder(session);
  }

  if (input === '98') {
    session.step = 'ORDER_HISTORY';
    await saveSession(session);
    return renderOrderHistory(session);
  }

  if (input === '99') {
    if (session.cart.length === 0) {
      await saveSession(session);
      return { reply: 'Your cart is empty.\n\n1. Place an order', quickReplies: ['1. Place an order'] };
    }
    session.step = 'CHECKOUT_CONFIRM';
    await saveSession(session);
    return renderCheckoutConfirm(session);
  }

  // "1" acts as "Place an order" from MAIN/ITEM_ADDED/AWAITING_PAYMENT, but
  // must NOT intercept when steps use "1" for their own numbered options
  // (e.g. SELECT_VARIANT option 1, VIEW_CART item removal, etc.).
  if (input === '1' && session.step !== 'SELECT_VARIANT' && session.step !== 'SELECT_ADDONS'
                     && session.step !== 'ENTER_QUANTITY' && session.step !== 'BROWSE_ITEMS'
                     && session.step !== 'VIEW_CART' && session.step !== 'CHECKOUT_CONFIRM'
                     && session.step !== 'CANCEL_CONFIRM' && session.step !== 'ORDER_HISTORY'
                     && session.step !== 'ORDER_DETAIL' && session.step !== 'COLLECT_CUSTOMER_INFO') {
    // "1" as "Place an order" shortcut (not consumed mid-flow or in cart)
    session.step    = 'BROWSE_CATEGORIES';
    session.context = {};
    await saveSession(session);
    return renderCategories();
  }

  if (input === '2' && session.step === 'MAIN') {
    session.step = 'VIEW_CART';
    await saveSession(session);
    return renderCart(session);
  }

  // ── Step-specific handlers ────────────────────────────────────────────────
  let result;

  switch (session.step) {
    // ── MAIN ──────────────────────────────────────────────────────────────
    case 'MAIN': {
      result = { reply: 'Please select a valid option.', ...renderMain(session) };
      break;
    }

    // ── BROWSE_CATEGORIES ─────────────────────────────────────────────────
    case 'BROWSE_CATEGORIES': {
      const cats = menu.getCategories();
      if (input === '0') {
        session.step = 'MAIN';
        result = renderMain(session);
      } else {
        const idx = parseInt(input, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= cats.length) {
          result = { reply: 'Invalid option. Enter a number from the list.', ...renderCategories() };
        } else {
          session.context.categoryId = cats[idx].id;
          session.step = 'BROWSE_ITEMS';
          result = renderItems(cats[idx].id);
        }
      }
      break;
    }

    // ── BROWSE_ITEMS ──────────────────────────────────────────────────────
    case 'BROWSE_ITEMS': {
      const items = menu.getItemsByCategory(session.context.categoryId);
      if (input === '0') {
        session.step = 'BROWSE_CATEGORIES';
        result = renderCategories();
      } else {
        const idx = parseInt(input, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= items.length) {
          result = { reply: 'Invalid option.', ...renderItems(session.context.categoryId) };
        } else {
          const item = items[idx];
          session.context.item   = item;
          session.context.variant = null;
          session.context.addons  = [];

          if (item.variants && item.variants.length > 0) {
            session.step = 'SELECT_VARIANT';
            result = renderVariants(item);
          } else if (item.addons && item.addons.length > 0) {
            session.step = 'SELECT_ADDONS';
            result = renderAddons(item);
          } else {
            session.step = 'ENTER_QUANTITY';
            result = renderQuantity(session);
          }
        }
      }
      break;
    }

    // ── SELECT_VARIANT ────────────────────────────────────────────────────
    case 'SELECT_VARIANT': {
      const { item } = session.context;
      if (input === '0') {
        session.step = 'BROWSE_ITEMS';
        result = renderItems(session.context.categoryId);
      } else {
        const idx = parseInt(input, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= item.variants.length) {
          result = { reply: 'Invalid option.', ...renderVariants(item) };
        } else {
          session.context.variant = item.variants[idx];
          if (item.addons && item.addons.length > 0) {
            session.step = 'SELECT_ADDONS';
            result = renderAddons(item);
          } else {
            session.step = 'ENTER_QUANTITY';
            result = renderQuantity(session);
          }
        }
      }
      break;
    }

    // ── SELECT_ADDONS ─────────────────────────────────────────────────────
    case 'SELECT_ADDONS': {
      const { item } = session.context;
      if (input === '0') {
        session.context.addons = [];
        session.step = 'ENTER_QUANTITY';
        result = renderQuantity(session);
      } else {
        const parts   = input.split(/[\s,]+/).filter(Boolean);
        const indices = parts.map(s => parseInt(s, 10) - 1);
        const valid   = indices.length > 0 && indices.every(i => !isNaN(i) && i >= 0 && i < item.addons.length);
        if (!valid) {
          result = { reply: 'Invalid. Enter comma-separated numbers or 0 to skip.', ...renderAddons(item) };
        } else {
          // Deduplicate
          const unique           = [...new Set(indices)];
          session.context.addons = unique.map(i => item.addons[i]);
          session.step           = 'ENTER_QUANTITY';
          result                 = renderQuantity(session);
        }
      }
      break;
    }

    // ── ENTER_QUANTITY ────────────────────────────────────────────────────
    case 'ENTER_QUANTITY': {
      const qty = parseInt(input, 10);
      if (isNaN(qty) || qty < 1 || qty > 20) {
        result = { reply: 'Please enter a quantity between 1 and 20.', ...renderQuantity(session) };
      } else {
        const { item, variant, addons } = session.context;
        const addonSum  = (addons || []).reduce((s, a) => s + a.price, 0);
        const unitPrice = (variant ? variant.price : item.price) + addonSum;

        const entry = {
          itemId:      item.id,
          itemName:    item.name,
          variantId:   variant ? variant.id    : null,
          variantLabel: variant ? variant.label : null,
          addons:      [...(addons || [])],
          quantity:    qty,
          unitPrice,
          totalPrice:  unitPrice * qty,
        };

        session.cart.push(entry);
        session.context.lastEntry = entry;
        session.step = 'ITEM_ADDED';
        result = renderItemAdded(entry);
      }
      break;
    }

    // ── ITEM_ADDED ────────────────────────────────────────────────────────
    case 'ITEM_ADDED': {
      if (input === '1') {
        session.step = 'BROWSE_CATEGORIES';
        result = renderCategories();
      } else if (input === '2') {
        session.step = 'VIEW_CART';
        result = renderCart(session);
      } else {
        result = { reply: 'Type 1 to add more, 2 to view cart, 99 to checkout, or 0 to cancel.', ...renderItemAdded(session.context.lastEntry) };
      }
      break;
    }

    // ── CHECKOUT_CONFIRM ──────────────────────────────────────────────────
    case 'CHECKOUT_CONFIRM': {
      if (input === '0') {
        session.step = 'VIEW_CART';
        result = renderCart(session);
      } else if (input === '1') {
        result = await doCheckout(session);
      } else if (input === '2') {
        session.step = 'SCHEDULE_DATETIME';
        result = renderSchedule();
      } else if (input === '3') {
        session.step = 'COLLECT_CUSTOMER_INFO';
        result = {
          reply: [
            '*Add contact details*',
            divider(),
            'Enter your name and phone number:',
            'Format: Name, 6XXXXXXXX',
            'Example: Jean Mballa, 677123456',
            divider(),
            '0. Skip',
          ].join('\n'),
          quickReplies: ['0. Skip'],
        };
      } else {
        result = { reply: 'Please enter 1, 2, 3, or 0.', ...renderCheckoutConfirm(session) };
      }
      break;
    }

    // ── COLLECT_CUSTOMER_INFO ─────────────────────────────────────────────
    case 'COLLECT_CUSTOMER_INFO': {
      if (input === '0') {
        session.step = 'CHECKOUT_CONFIRM';
        result = renderCheckoutConfirm(session);
      } else {
        const match = input.match(/^(.+?),\s*(6\d{8}|\d{9,})$/);
        if (!match) {
          result = {
            reply: ['Invalid format. Use: Name, 6XXXXXXXX', 'Example: Jean, 677123456', divider(), '0. Skip'].join('\n'),
            quickReplies: ['0. Skip'],
          };
        } else {
          session.customerInfo = { name: match[1].trim(), phone: match[2].trim() };
          session.step = 'CHECKOUT_CONFIRM';
          result = { reply: 'Contact info saved.', ...renderCheckoutConfirm(session) };
        }
      }
      break;
    }

    // ── CANCEL_CONFIRM ────────────────────────────────────────────────────
    case 'CANCEL_CONFIRM': {
      if (input === '1') {
        result = doCancel(session);
      } else {
        session.step = session.context.prevStep || 'MAIN';
        result = renderMain(session);
      }
      break;
    }

    // ── ORDER_HISTORY ─────────────────────────────────────────────────────
    case 'ORDER_HISTORY': {
      if (input === '0') {
        session.step = 'MAIN';
        result = renderMain(session);
      } else {
        const idx = parseInt(input, 10) - 1;
        const orders = session.orders || [];
        if (isNaN(idx) || idx < 0 || idx >= orders.length) {
          result = { reply: 'Invalid option.', ...renderOrderHistory(session) };
        } else {
          session.context.viewingOrderIdx = idx;
          session.step = 'ORDER_DETAIL';
          result = renderOrderDetail(orders[idx]);
        }
      }
      break;
    }

    // ── ORDER_DETAIL ──────────────────────────────────────────────────────
    case 'ORDER_DETAIL': {
      session.step = 'ORDER_HISTORY';
      result = renderOrderHistory(session);
      break;
    }

    // ── VIEW_CART ─────────────────────────────────────────────────────────
    case 'VIEW_CART': {
      if (session.cart.length === 0) {
        session.step = 'MAIN';
        result = { reply: 'Your cart is empty.', ...renderMain(session) };
        break;
      }
      const idx = parseInt(input, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < session.cart.length) {
        const removed = session.cart.splice(idx, 1)[0];
        if (session.cart.length === 0) {
          session.step = 'MAIN';
          result = { reply: `Removed *${removed.itemName}*. Cart is now empty.`, ...renderMain(session) };
        } else {
          result = { reply: `Removed *${removed.itemName}*.\n\n` + renderCart(session).reply, quickReplies: renderCart(session).quickReplies };
        }
      } else {
        result = { reply: 'Type an item number to remove it, or use the options below.', ...renderCart(session) };
      }
      break;
    }

    // ── AWAITING_PAYMENT ──────────────────────────────────────────────────
    case 'AWAITING_PAYMENT': {
      const order = session.orders.find(o => o.id === session.context.orderId);
      if (input === '1') {
        // Treat "1" as "Place a new order"
        session.step    = 'BROWSE_CATEGORIES';
        session.context = {};
        result = renderCategories();
      } else if (order && order.paymentUrl) {
        result = {
          reply: [
            `Order *${order.reference}* is awaiting payment.`,
            `Total: *${fmt(order.subtotal)}*`,
            divider(),
            'Tap below to complete payment.',
            divider(),
            '1. Place a new order',
          ].join('\n'),
          quickReplies: ['1. Place a new order'],
          paymentUrl: order.paymentUrl,
        };
      } else {
        result = renderMain(session);
        session.step = 'MAIN';
      }
      break;
    }

    // ── SCHEDULE_DATETIME ─────────────────────────────────────────────────
    case 'SCHEDULE_DATETIME': {
      if (input === '0') {
        // Skip scheduling — checkout immediately
        const r = await doCheckout(session);
        await saveSession(session);
        return r;
      }
      const match = input.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
      if (!match) {
        result = { reply: 'Invalid format. Use DD/MM HH:MM — e.g. 25/07 19:30', ...renderSchedule() };
      } else {
        const [, day, month, hour, min] = match;
        const scheduled = new Date(
          new Date().getFullYear(),
          parseInt(month, 10) - 1,
          parseInt(day, 10),
          parseInt(hour, 10),
          parseInt(min, 10)
        );
        if (isNaN(scheduled.getTime()) || scheduled <= new Date()) {
          result = { reply: 'Please enter a future date and time.', ...renderSchedule() };
        } else {
          const label = scheduled.toLocaleString('en-CM', { dateStyle: 'medium', timeStyle: 'short' });
          result = await doCheckout(session, { label, iso: scheduled.toISOString() });
        }
      }
      break;
    }

    default: {
      session.step = 'MAIN';
      result = renderMain(session);
    }
  }

  saveSession(session);
  return result;
}

/**
 * Return the MAIN menu screen for a session (used on first page load).
 * Creates a blank session if this is the customer's first visit.
 *
 * @param {string} sessionId
 * @returns {Promise<{ reply: string, quickReplies: string[] }>}
 */
async function getWelcome(sessionId) {
  const session = await getSession(sessionId);
  return renderMain(session);
}

module.exports = { handleMessage, getWelcome };
