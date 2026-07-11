'use strict';

const categories = [
  { id: 1, name: 'Soups & Starters' },
  { id: 2, name: 'Main Dishes' },
  { id: 3, name: 'Grills & BBQ' },
  { id: 4, name: 'Drinks' },
  { id: 5, name: 'Desserts' },
];

// Items with variants use variant prices.
// Items without variants use a top-level price field.
const items = [
  // --- Soups & Starters ---
  {
    id: 1, categoryId: 1,
    name: 'Pepper Soup',
    description: 'Spiced meat or fish broth',
    variants: [
      { id: 'meat', label: 'Meat',  price: 2000 },
      { id: 'fish', label: 'Fish',  price: 2500 },
      { id: 'mix',  label: 'Mixed', price: 3000 },
    ],
    addons: [],
  },
  {
    id: 2, categoryId: 1,
    name: 'Garden Salad',
    description: 'Fresh vegetables with house dressing',
    variants: [],
    price: 1500,
    addons: [
      { id: 'chicken', label: 'Grilled Chicken', price: 1000 },
      { id: 'egg',     label: 'Boiled Egg',      price: 300  },
    ],
  },

  // --- Main Dishes ---
  {
    id: 3, categoryId: 2,
    name: 'Ndolé',
    description: 'Bitter leaf stew with groundnuts',
    variants: [
      { id: 'sm', label: 'Small', price: 1500 },
      { id: 'lg', label: 'Large', price: 2500 },
    ],
    addons: [
      { id: 'plantain',    label: 'Fried Plantain', price: 500 },
      { id: 'rice',        label: 'Rice',            price: 500 },
      { id: 'miondo',      label: 'Miondo',          price: 300 },
    ],
  },
  {
    id: 4, categoryId: 2,
    name: 'Poulet DG',
    description: 'Director General chicken with fried plantain',
    variants: [
      { id: 'half', label: 'Half Chicken', price: 5000 },
      { id: 'full', label: 'Full Chicken', price: 9000 },
    ],
    addons: [],
  },
  {
    id: 5, categoryId: 2,
    name: 'Eru',
    description: 'Wild spinach with waterleaf and crayfish',
    variants: [
      { id: 'sm', label: 'Small', price: 1500 },
      { id: 'lg', label: 'Large', price: 2500 },
    ],
    addons: [
      { id: 'fufu',       label: 'Fufu Corn',  price: 400 },
      { id: 'water_fufu', label: 'Water Fufu', price: 400 },
    ],
  },
  {
    id: 6, categoryId: 2,
    name: 'Jollof Rice',
    description: 'Spiced tomato rice',
    variants: [
      { id: 'plain',   label: 'Plain',        price: 1000 },
      { id: 'chicken', label: 'With Chicken', price: 2000 },
      { id: 'beef',    label: 'With Beef',    price: 1800 },
    ],
    addons: [
      { id: 'plantain', label: 'Fried Plantain', price: 500 },
      { id: 'coleslaw', label: 'Coleslaw',        price: 300 },
    ],
  },

  // --- Grills & BBQ ---
  {
    id: 7, categoryId: 3,
    name: 'Suya',
    description: 'Spiced beef skewers',
    variants: [
      { id: '3pc', label: '3 Skewers', price: 1500 },
      { id: '6pc', label: '6 Skewers', price: 2800 },
    ],
    addons: [
      { id: 'onion',  label: 'Extra Onions', price: 100 },
      { id: 'pepper', label: 'Extra Pepper', price: 100 },
    ],
  },
  {
    id: 8, categoryId: 3,
    name: 'Grilled Fish',
    description: 'Fresh fish, charcoal grilled',
    variants: [
      { id: 'tilapia', label: 'Tilapia',  price: 3500 },
      { id: 'catfish', label: 'Catfish',  price: 4000 },
    ],
    addons: [
      { id: 'sauce',    label: 'Pepper Sauce',   price: 300 },
      { id: 'plantain', label: 'Fried Plantain', price: 500 },
    ],
  },

  // --- Drinks ---
  {
    id: 9, categoryId: 4,
    name: 'Soft Drink',
    description: 'Coca-Cola, Fanta, Sprite',
    variants: [
      { id: '33cl', label: '33cl', price: 500  },
      { id: '150cl', label: '1.5L', price: 1000 },
    ],
    addons: [],
  },
  {
    id: 10, categoryId: 4,
    name: 'Fresh Juice',
    description: 'Mango, Orange or Pineapple',
    variants: [
      { id: 'mango',     label: 'Mango',     price: 800 },
      { id: 'orange',    label: 'Orange',    price: 800 },
      { id: 'pineapple', label: 'Pineapple', price: 800 },
    ],
    addons: [],
  },
  {
    id: 11, categoryId: 4,
    name: 'Beer',
    description: 'Castel, 33 Export, Beaufort',
    variants: [
      { id: 'castel',   label: 'Castel 65cl',    price: 1200 },
      { id: '33export', label: '33 Export 65cl',  price: 1200 },
      { id: 'beaufort', label: 'Beaufort 65cl',   price: 1000 },
    ],
    addons: [],
  },
  {
    id: 12, categoryId: 4,
    name: 'Water',
    description: 'Bottled water',
    variants: [
      { id: '50cl',  label: '50cl', price: 300 },
      { id: '150cl', label: '1.5L', price: 500 },
    ],
    addons: [],
  },

  // --- Desserts ---
  {
    id: 13, categoryId: 5,
    name: 'Beignets',
    description: 'Deep-fried dough balls',
    variants: [],
    price: 500,
    addons: [
      { id: 'honey',     label: 'Honey',           price: 200 },
      { id: 'choc_sauce', label: 'Chocolate sauce', price: 300 },
    ],
  },
  {
    id: 14, categoryId: 5,
    name: 'Puff Puff',
    description: 'Sweet fried dough',
    variants: [],
    price: 500,
    addons: [],
  },
  {
    id: 15, categoryId: 5,
    name: 'Ice Cream',
    description: 'Vanilla, Chocolate or Strawberry',
    variants: [
      { id: 'vanilla',    label: 'Vanilla',    price: 800 },
      { id: 'chocolate',  label: 'Chocolate',  price: 800 },
      { id: 'strawberry', label: 'Strawberry', price: 800 },
    ],
    addons: [],
  },
];

function getCategories() {
  return categories;
}

function getCategory(id) {
  return categories.find(c => c.id === id);
}

function getItemsByCategory(categoryId) {
  return items.filter(i => i.categoryId === categoryId);
}

function getItem(id) {
  return items.find(i => i.id === id);
}

module.exports = { getCategories, getCategory, getItemsByCategory, getItem };
