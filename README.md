# SignalRGB LIFX

A SignalRGB network add-on that discovers and controls LIFX lights directly over the local network. Each linked light appears as a one-pixel device in the SignalRGB layout and follows the active canvas effect.

[![Add to My SignalRGB Installation](https://marketplace.signalrgb.com/resources/add-extension-256.png "Add to My SignalRGB Installation")](https://srgbmods.net/s?p=addon/install?url=https://github.com/BigChiefRick/SignalRGB-LIFX)

## Current status

Version `0.1.2` is the current hardware-test release.

- Local LAN control only; no LIFX cloud account or API token.
- Automatic UDP discovery on port `56700`.
- Manual IPv4 fallback when broadcast discovery is blocked.
- Standard single-zone color lights render as one SignalRGB canvas point.
- Color updates are capped at 20 packets per second, matching LIFX's published limit.
- Controllers are keyed by responder IP because SignalRGB's discovery-service text boundary does not preserve arbitrary binary address bytes. Reserve each bulb's DHCP address for a stable SignalRGB device identity.
- LIFX multizone strips, Beam, Candle, Tile, and matrix products currently render as one color for the entire device. Per-zone support is planned separately.

Version `0.1.1` fixes duplicate device announcements and sends wildcard-target LIFX packets to the responder IP on the fixed LAN protocol port `56700`. It also migrates the malformed cache produced by `0.1.0` during the next SignalRGB restart. Version `0.1.2` uses SignalRGB's runtime `connection` event so canvas rendering starts after the UDP socket connects.

The protocol packet builder has automated tests. Live discovery and color output still need validation inside SignalRGB on real hardware before this should be called a stable release.

## Install

1. Click **Add to My SignalRGB Installation** above.
2. Allow the browser to open SignalRGB and approve the add-on installation.
3. Open the LIFX add-on page in SignalRGB.
4. Select **Link** next to each discovered light.
5. Move each LIFX device to the desired position on the SignalRGB layout canvas.

GitHub does not activate custom application protocols directly from README links, so the button uses the HTTPS redirect provided by SRGBmods. The redirect opens `signalrgb://addon/install?url=https://github.com/BigChiefRick/SignalRGB-LIFX` locally; it does not replace or repackage the repository.

If a light is not discovered, confirm the PC and light are on the same LAN, disconnect any VPN that captures local broadcast traffic, or enter the light's IPv4 address and select **Check IP**.

## Coexistence with other LIFX controllers

The LIFX mobile app and Stream Deck controls can remain installed. While a light is linked, SignalRGB sends its canvas color about 20 times per second when the effect is changing, so one-off color commands from another controller will be replaced by the next SignalRGB frame. Power commands from another controller remain usable; SignalRGB powers the light on only when it first links or starts unless that option is disabled.

## Development

Requirements: Node.js 20 or newer for protocol tests.

```powershell
npm test
```

The add-on itself is `LIFX.js` plus `LIFX.qml`. It follows the network add-on lifecycle used by SignalRGB's Govee, Yeelight, Nanoleaf, and Philips Hue repositories while implementing the binary LIFX LAN protocol independently.

## References

- [SignalRGB network communication documentation](https://docs.signalrgb.com/developer/plugins/advanced-communication/)
- [SignalRGB Govee add-on](https://gitlab.com/signalrgb/Govee)
- [SignalRGB Yeelight add-on](https://gitlab.com/signalrgb/yeelight)
- [Official LIFX LAN protocol documentation](https://lan.developer.lifx.com/)
- [Official LIFX product registry](https://github.com/LIFX/products)
- [LIFX Control for Stream Deck](https://gitlab.com/wwsean08/lifx-streamdeck) (archived; MIT)

## License

MIT
