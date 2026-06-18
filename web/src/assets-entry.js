import { bootstrap } from './lib/bootstrap.js';
import { createAssetsView } from './assets/view.js';
import { mountChatWidget } from './lib/chat-widget.js';

bootstrap((coord) => createAssetsView(coord));

// Floating "a//y" chat assistant (assets page only for now).
mountChatWidget();
