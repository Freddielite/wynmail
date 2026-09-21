import { defaultBlock, defaultDesign } from './render.js';

const mk = (type, props = {}) => { const b = defaultBlock(type); b.props = { ...b.props, ...props }; return b; };
const design = (settings, blocks) => { const d = defaultDesign(); d.settings = { ...d.settings, ...settings }; d.blocks = [...blocks, d.blocks[0]]; return d; };
const NAVY = '#0b2a5b';
const BLUE = '#1d4ed8';

export const PRESETS = [
  { key: 'blank', name: 'Blank', description: 'Start from nothing and add your own blocks.', make: () => design({}, []) },
  {
    key: 'welcome', name: 'Welcome', description: 'A warm hello with one clear next step.',
    make: () => design({}, [
      mk('heading', { text: 'Welcome, {{first_name|friend}}!', padY: 28 }),
      mk('text', { text: 'Thanks for joining us. Here is what you can expect from us, and how to get in touch whenever you need us.\n\nWe are glad to have you.' }),
      mk('button', { label: 'Get started', url: 'https://', padY: 20 }),
      mk('divider'),
      mk('text', { text: 'Questions? Just reply to this email.', size: 14, color: '#64748b', align: 'center' })
    ])
  },
  {
    key: 'newsletter', name: 'Newsletter', description: 'A header, a lead story and two short articles.',
    make: () => design({}, [
      mk('heading', { text: 'This month with us', bg: NAVY, color: '#ffffff', align: 'center', padY: 30 }),
      mk('image', { padY: 0 }),
      mk('heading', { text: 'The story of the month', level: 2, padY: 18 }),
      mk('text', { text: 'Tell your readers the most important news first. Keep it short, friendly and useful.' }),
      mk('button', { label: 'Read more', url: 'https://', align: 'left' }),
      mk('divider'),
      (() => { const c = mk('columns'); c.props.cols = [
        [mk('heading', { text: 'First article', level: 3, padX: 0 }), mk('text', { text: 'A short summary of your first article goes here.', padX: 0, size: 14 })],
        [mk('heading', { text: 'Second article', level: 3, padX: 0 }), mk('text', { text: 'A short summary of your second article goes here.', padX: 0, size: 14 })]
      ]; return c; })(),
      mk('social')
    ])
  },
  {
    key: 'promo', name: 'Promotion', description: 'A bold offer with a big button.',
    make: () => design({ contentBg: '#ffffff' }, [
      mk('heading', { text: 'A gift for you, {{first_name|friend}}', bg: BLUE, color: '#ffffff', align: 'center', padY: 34 }),
      mk('heading', { text: '20% off everything', level: 2, align: 'center', padY: 22 }),
      mk('text', { text: 'For a limited time only. Use the code below at checkout.', align: 'center' }),
      mk('heading', { text: 'WELCOME20', level: 2, align: 'center', color: BLUE, bg: '#eff6ff', padY: 16 }),
      mk('button', { label: 'Shop now', url: 'https://', padY: 24, radius: 8 }),
      mk('text', { text: 'Offer ends soon. Terms apply.', size: 13, color: '#64748b', align: 'center' })
    ])
  },
  {
    key: 'announcement', name: 'Announcement', description: 'Share news in a few short lines.',
    make: () => design({ font: 'georgia' }, [
      mk('heading', { text: 'Big news from our team', level: 2, padY: 28 }),
      mk('text', { text: 'Hello {{first_name|there}},\n\nWe are excited to share something new with you. Explain the announcement here in a few clear sentences.\n\nThank you for being with us.' }),
      mk('button', { label: 'Learn more', url: 'https://', align: 'left' }),
      mk('spacer')
    ])
  },
  {
    key: 'letter', name: 'Simple letter', description: 'Looks like a personal email. Great for deliverability.',
    make: () => design({ background: '#ffffff', font: 'georgia', fontSize: 17, width: 560 }, [
      mk('text', { text: 'Hi {{first_name|there}},\n\nWrite your message like you would to one person. Keep it short and honest.\n\nBest wishes,\nYour name', padY: 24 })
    ])
  }
];
