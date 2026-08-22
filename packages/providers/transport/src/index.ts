/**
 * Transportlaag: de WebRTC-room waarin cliënt, agent en avatar samenkomen.
 *
 * Gescheiden van de avatarprovider omdat de room ook zonder avatar bestaat — een
 * intake met alleen microfoon gebruikt dezelfde room, en de null-provider publiceert er
 * niets in.
 */
export * from './livekit-rooms';
export * from './livekit-token';
