// Shared base for Plaid subsystems. Each subsystem owns the signals it
// connects, so cleanup is a single disconnectObject() sweep in destroy().

export class PlaidSubsystem {
    constructor(core) {
        this.core = core;
        this._tokens = [];
    }

    // The token names its emitter and the subsystem that holds it, so any
    // subsystem's disconnectToken releases it, and the list keeps no token
    // (nor the window or actor it names) once disconnected.
    connectObject(emitter, ...args) {
        const token = { emitter, owner: this };
        emitter.connectObject(...args, token);
        this._tokens.push(token);
        return token;
    }

    // Disconnects a token from connectObject, whichever subsystem made it.
    disconnectToken(token) {
        const owner = token?.owner;
        const i = owner?._tokens.indexOf(token) ?? -1;
        if (i < 0) return;
        owner._tokens.splice(i, 1);
        token.emitter.disconnectObject(token);
    }

    disconnectAll() {
        for (const token of this._tokens)
            token.emitter.disconnectObject(token);
        this._tokens = [];
    }

    destroy() {
        this.disconnectAll();
    }
}
