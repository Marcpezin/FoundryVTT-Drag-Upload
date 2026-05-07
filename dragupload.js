// Drag Upload — Foundry VTT v13+ only.

const FP = () => foundry.applications.apps.FilePicker.implementation;

Hooks.once('init', async () => {
    const usingTheForge = typeof ForgeVTT != "undefined" && ForgeVTT.usingTheForge;

    game.settings.register("dragupload-revived", "fileUploadSource", {
        name: "The path files should be uploaded to",
        scope: "world",
        config: !usingTheForge,
        type: String,
        default: usingTheForge ? "forgevtt" : "data",
        choices: {
            "data": game.i18n.localize("FILES.SourceUser"),
            "s3": game.i18n.localize("FILES.SourceS3"),
        },
        onChange: async () => { await initializeDragUpload(); }
    });

    game.settings.register("dragupload-revived", "fileUploadFolder", {
        name: "The path files should be uploaded to",
        hint: "Should look like 'dragupload/uploaded'",
        scope: "world",
        config: true,
        type: String,
        default: "dragupload/uploaded",
        onChange: async () => { await initializeDragUpload(); }
    });

    try {
        const buckets = await FP().browse("s3", "");
        let bucketChoices = {};
        for (let bucket of buckets.dirs) {
            bucketChoices[bucket] = bucket;
        }
        game.settings.register("dragupload-revived", "fileUploadBucket", {
            name: "If using S3, what S3 bucket should be used",
            scope: "world",
            config: !usingTheForge,
            type: String,
            default: usingTheForge ? "" : (FP().S3_BUCKETS?.length > 0 ? FP().S3_BUCKETS[0] : ""),
            choices: bucketChoices,
            onChange: async () => { await initializeDragUpload(); }
        });
    } catch {}
});

Hooks.once('ready', async function () {
    await initializeDragUpload();

    // Drag-and-drop handling needs to cover two distinct paths:
    //
    //  - Internal Foundry drags (Actor / Item / JournalEntry from sidebars,
    //    Compendium entries, etc.) come in through Foundry's own DragDrop
    //    binding, which calls Canvas#_onDrop. We wrap that method so we can
    //    intercept first; if the drop is ours we handle it, otherwise we
    //    delegate to the original handler so Foundry places the document.
    //
    //  - Drops of OS files or web-browser URLs do NOT seem to be routed
    //    through Foundry's Canvas DragDrop in V13 — Foundry's drop handler
    //    only fires when the drag carries Foundry-formatted JSON data. So
    //    we additionally bind a DOM `drop` listener on `#board` to catch
    //    those external drops directly.
    //
    // Both paths funnel through `tryHandleExternalDrop`, which uses an
    // event-level marker to make itself idempotent — even if both paths
    // fire for the same drop event, the file is uploaded only once.

    const CanvasClass = foundry.canvas?.Canvas ?? globalThis.Canvas;
    if (CanvasClass?.prototype?._onDrop) {
        const original = CanvasClass.prototype._onDrop;
        CanvasClass.prototype._onDrop = async function (event) {
            const handled = await tryHandleExternalDrop.call(this, event);
            if (handled) return;
            return original.call(this, event);
        };
    } else {
        console.warn("DragUpload | Canvas#_onDrop not found, internal drag passthrough may misbehave");
    }

    const board = document.getElementById("board");
    if (board) {
        board.addEventListener("dragover", event => event.preventDefault());
        board.addEventListener("drop", event => { tryHandleExternalDrop(event); });
    } else {
        console.warn("DragUpload | #board element not found, external drops disabled");
    }
});

async function initializeDragUpload() {
    if (game.user.isGM || game.user.hasPermission(CONST.USER_PERMISSIONS.FILES_UPLOAD)) {
        await createFoldersIfMissing();
    }

    let folderParts = [];
    const targetFolder = game.settings.get("dragupload-revived", "fileUploadFolder");
    folderParts = folderParts.concat(targetFolder.split("/")).filter(x => x !== "");

    window.dragUpload = {};
    window.dragUpload.targetFolder = folderParts.join("/");
}

async function createFoldersIfMissing() {
    const targetLocation = game.settings.get("dragupload-revived", "fileUploadFolder");
    const targetLocationFolders = targetLocation.split("/").filter(x => x !== "");
    let pathParts = [];
    for (const folder of targetLocationFolders) {
        pathParts.push(folder);
        await createFolderIfMissing(pathParts.join("/"));
    }
    await createFolderIfMissing(pathParts.concat("tokens").join("/"));
    await createFolderIfMissing(pathParts.concat("tiles").join("/"));
    await createFolderIfMissing(pathParts.concat("ambient").join("/"));
    await createFolderIfMissing(pathParts.concat("journals").join("/"));
}

async function createFolderIfMissing(folderPath) {
    const source = game.settings.get("dragupload-revived", "fileUploadSource");
    const bucketOpts = source === "s3" ? { bucket: game.settings.get("dragupload-revived", "fileUploadBucket") } : {};
    try {
        const result = await FP().browse(source, folderPath);
        if (!result.dir.includes(folderPath)) {
            await FP().createDirectory(source, folderPath, bucketOpts);
        }
    } catch (error) {
        try {
            await FP().createDirectory(source, folderPath, bucketOpts);
        } catch {}
    }
}

/**
 * Inspect the drop event and, if it looks like an external file or web URL we
 * want to handle, process it. Returns true when we have taken responsibility
 * for the drop (caller should NOT delegate to Foundry's original handler) or
 * false when we leave it untouched.
 *
 * Idempotent — if called more than once for the same event (e.g. once via the
 * DOM drop listener and once via the Canvas#_onDrop wrapper), the second call
 * returns the cached outcome without re-uploading the file.
 */
async function tryHandleExternalDrop(event) {
    if (event._dragUploadOutcome !== undefined) {
        return event._dragUploadOutcome;
    }
    // Initialise to a pending Promise so that overlapping invocations all
    // wait on the same upload rather than starting their own.
    let resolveOutcome;
    event._dragUploadOutcome = new Promise(r => (resolveOutcome = r));
    try {
        const result = await processDrop(event);
        event._dragUploadOutcome = result;
        resolveOutcome(result);
        return result;
    } catch (err) {
        event._dragUploadOutcome = false;
        resolveOutcome(false);
        throw err;
    }
}

async function processDrop(event) {
    console.debug("DragUpload | drop event:", event);

    // Internal Foundry drags carry JSON-encoded document data in one of the
    // dataTransfer types. If we find any, this drop belongs to Foundry — bail.
    for (const type of event.dataTransfer.types ?? []) {
        if (type === "Files") continue;
        const data = event.dataTransfer.getData(type);
        if (!data) continue;
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") {
                console.debug("DragUpload | Internal Foundry drag detected, delegating");
                return false;
            }
        } catch { /* not JSON, fall through */ }
    }

    // Otherwise we only handle two cases:
    //   1. A real OS file is being dropped (dataTransfer.files non-empty).
    //   2. A clear http(s) URL is being dropped from a web browser.
    const files = event.dataTransfer?.files;
    let file;
    if (files && files.length > 0) {
        file = files[0];
    } else {
        const text = (event.dataTransfer.getData("text/plain") || "").trim();
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            return false;
        }

        let url = text;
        // trimming query string
        if (url.includes("?")) url = url.substr(0, url.indexOf("?"));
        const splitUrl = url.split("/");
        let filename = splitUrl[splitUrl.length - 1];
        if (!filename.includes(".")) {
            console.log("DragUpload | Dragged URL has no filename:", text);
            return false;
        }
        const extension = filename.substr(filename.lastIndexOf(".") + 1);
        const validExtensions = Object.keys(CONST.IMAGE_FILE_EXTENSIONS)
            .concat(Object.keys(CONST.VIDEO_FILE_EXTENSIONS))
            .concat(Object.keys(CONST.AUDIO_FILE_EXTENSIONS));
        if (!validExtensions.includes(extension)) {
            console.log("DragUpload | Dragged URL has unsupported extension:", text);
            return false;
        }
        // special case: chrome imgur drag from an album gives a low-res webp file instead of a PNG
        if (url.includes("imgur") && filename.endsWith("_d.webp")) {
            filename = filename.substr(0, filename.length - "_d.webp".length) + ".png";
            url = url.substr(0, url.length - "_d.webp".length) + ".png";
        }
        file = { isExternalUrl: true, url: url, name: filename };
    }

    // We're taking this drop — prevent the browser default (which would
    // navigate to a dropped URL or open a dropped file).
    event.preventDefault();

    console.debug("DragUpload | handling file:", file);

    if (Object.keys(CONST.AUDIO_FILE_EXTENSIONS).filter(x => x != "webm" && file.name.endsWith(x)).length > 0) {
        await HandleAudioFile(event, file);
        return true;
    }

    const layer = game.canvas.activeLayer?.name ?? "";

    if (layer.includes("TokenLayer")) {
        await CreateActor(event, file);
    } else if (layer.includes("NotesLayer")) {
        await CreateJournalPin(event, file);
    } else {
        await CreateTile(event, file);
    }
    return true;
}

async function HandleAudioFile(event, file) {
    console.debug(file.name + " is an audio file");
    await CreateAmbientAudio(event, file);
}

async function uploadOrUseUrl(file, subfolder) {
    if (file.isExternalUrl) return { path: file.url };
    const source = game.settings.get("dragupload-revived", "fileUploadSource");
    const bucketOpts = source === "s3" ? { bucket: game.settings.get("dragupload-revived", "fileUploadBucket") } : {};
    return FP().upload(source, `${window.dragUpload.targetFolder}/${subfolder}`, file, bucketOpts);
}

async function CreateAmbientAudio(event, file) {
    const response = await uploadOrUseUrl(file, "ambient");

    const data = {
        path: response.path,
        radius: 10,
        easing: true,
        repeat: true,
        volume: 1.0
    };

    convertXYtoCanvas(data, event);

    canvas.sounds.activate();
    await canvas.scene.createEmbeddedDocuments("AmbientSound", [data]);
}

async function CreateTile(event, file) {
    const response = await uploadOrUseUrl(file, "tiles");

    const data = {};
    convertXYtoCanvas(data, event);
    data.texture = { src: response.path };

    const tex = await foundry.canvas.loadTexture(response.path);
    data.width = tex.width;
    data.height = tex.height;

    // Center on the cursor
    data.x = data.x - (data.width / 2);
    data.y = data.y - (data.height / 2);

    if (!event.shiftKey) {
        const snapped = canvas.grid.getSnappedPoint(
            { x: data.x, y: data.y },
            { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX, resolution: 1 }
        );
        data.x = snapped.x;
        data.y = snapped.y;
    }

    if (event.altKey) data.hidden = true;

    return canvas.scene.createEmbeddedDocuments('Tile', [data], {});
}

async function CreateJournalPin(event, file) {
    const response = await uploadOrUseUrl(file, "journals");
    console.debug("Got response: ");
    console.debug(response);

    const journal = await JournalEntry.create({ name: file.name });
    console.debug("Created journal entry: ");
    console.debug(journal);

    const [page] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
        name: file.name,
        type: "image",
        src: response.path
    }]);

    const pinData = {
        entryId: journal.id,
        pageId: page?.id,
        texture: { src: "icons/svg/book.svg" },
        iconSize: 40,
        text: "",
        fontSize: 48,
        textAnchor: CONST.TEXT_ANCHOR_POINTS.CENTER
    };

    convertXYtoCanvas(pinData, event);

    canvas.notes.activate();
    return canvas.scene.createEmbeddedDocuments('Note', [pinData], {});
}

async function CreateActor(event, file) {
    const response = await uploadOrUseUrl(file, "tokens");
    console.debug("Got response: ");
    console.debug(response);

    const data = CreateImgData(event, response);
    data.name = file.name;
    const tokenImageData = CreateImgData(event, response);

    if (Object.keys(CONST.IMAGE_FILE_EXTENSIONS).filter(x => file.name.endsWith(x)).length == 0) {
        data.img = "";
    }

    // Ensure the user has permission to drop the actor and create a Token
    if (!game.user.can("TOKEN_CREATE")) {
        return ui.notifications.warn(`You do not have permission to create new Tokens!`);
    }

    const types = Object.keys(CONFIG.Actor.sheetClasses);
    types.push("actorless");

    if (types.length > 1) {
        const options = types.map(t => `<option value="${t}">${t}</option>`).join("");
        const content = `
            <div class="form-group">
                <label>Actor type:</label>
                <select name="actorType" autofocus>${options}</select>
            </div>`;

        let chosen;
        try {
            chosen = await foundry.applications.api.DialogV2.prompt({
                window: { title: "What Type should this Actor be created as?" },
                content,
                ok: {
                    label: "Create",
                    callback: (event, button) => button.form.elements.actorType.value
                },
                rejectClose: false
            });
        } catch {
            return; // dialog dismissed
        }
        if (!chosen) return;
        await CreateActorWithType(event, data, tokenImageData, chosen);
    } else {
        await CreateActorWithType(event, data, tokenImageData, types[0]);
    }
}

async function CreateActorWithType(event, data, tokenImageData, type) {
    let createdType = type;
    if (type === "actorless") {
        createdType = Object.keys(CONFIG.Actor.sheetClasses)[0];
    }

    let actorName = data.name;
    if (actorName.includes(".")) {
        actorName = actorName.split(".")[0];
    }

    const actor = await getDocumentClass("Actor").create({
        name: actorName,
        type: createdType,
        img: data.img
    });

    const prototypeToken = actor.prototypeToken;
    const actorId = actor._id;

    // Prepare Token data specific to this placement
    const hg = canvas.dimensions.size / 2;
    data.x -= (prototypeToken.width * hg);
    data.y -= (prototypeToken.height * hg);

    let tokenData = {
        x: data.x,
        y: data.y,
        hidden: event.altKey,
        texture: { src: tokenImageData.img }
    };

    // Snap the dropped position and clamp it to scene bounds
    if (!event.shiftKey) {
        const snapped = canvas.grid.getSnappedPoint(
            { x: data.x, y: data.y },
            { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX, resolution: 1 }
        );
        tokenData.x = snapped.x;
        tokenData.y = snapped.y;
    }
    const d = canvas.dimensions;
    tokenData.x = Math.clamp(tokenData.x, 0, d.width - 1);
    tokenData.y = Math.clamp(tokenData.y, 0, d.height - 1);

    // Get the Token image
    if (prototypeToken.randomImg) {
        let images = await actor.getTokenImages();
        images = images.filter(i => (images.length === 1) || !(i === this._lastWildcard));
        const image = images[Math.floor(Math.random() * images.length)];
        this._lastWildcard = image;
        tokenData.texture = { src: image };
    }

    // Merge Token data with the prototype token defaults
    tokenData = foundry.utils.mergeObject(prototypeToken.toObject(), tokenData, { inplace: true });
    tokenData.actorId = actorId;
    tokenData.actorLink = true;

    canvas.tokens.activate();
    await canvas.scene.createEmbeddedDocuments('Token', [tokenData], {});

    // delete actor if it's actorless
    if (type === "actorless") {
        actor.delete();
    }
}

function CreateImgData(event, response) {
    const data = {
        img: response.path
    };

    convertXYtoCanvas(data, event);

    return data;
}

function convertXYtoCanvas(data, event) {
    // Acquire the cursor position transformed to Canvas coordinates
    const [x, y] = [event.clientX, event.clientY];
    const t = canvas.stage.worldTransform;
    data.x = (x - t.tx) / canvas.stage.scale.x;
    data.y = (y - t.ty) / canvas.stage.scale.y;

    // Allow other modules to overwrite this, such as Isometric
    Hooks.callAll("dragDropPositioning", { event: event, data: data });
    console.debug("Converted x/y values to canvas: ");
    console.debug(data);
}
