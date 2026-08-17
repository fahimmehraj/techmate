import type { RoomProvider, RoomProviderRegistry } from "@technyu/application";
import { OnceHubElabRoomProvider } from "./oncehub-elab.ts";

export class BuiltInRoomProviderRegistry implements RoomProviderRegistry {
  private readonly providers: RoomProvider[] = [new OnceHubElabRoomProvider()];
  list() { return this.providers; }
  get(providerId: string) { return this.providers.find((provider) => provider.id === providerId); }
}
