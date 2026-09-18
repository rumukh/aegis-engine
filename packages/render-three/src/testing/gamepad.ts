/** Mutable standard-mapped hardware fixture; not a native/physical device claim. */
export function virtualGamepad(index = 0) {
  return {
    id: `Virtual standard controller ${index}`,
    index,
    mapping: 'standard',
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}
