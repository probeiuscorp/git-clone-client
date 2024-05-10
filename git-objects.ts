import { createInflate } from 'node:zlib';
import { buffer as bufferFromStream } from 'node:stream/consumers';
import { createHash } from 'node:crypto';

export type GitPacketLine = {
    type: 'flush';
} | {
    type: 'data';
    payload: Buffer;
};
export function readPacketLines(buffer: Buffer) {
    const packetLines: GitPacketLine[] = [];
    const len = buffer.byteLength;
    let i=0;
    while(i < len) {
        const sizeString = buffer.toString('ascii', i, i + 4);
        const size = parseInt(sizeString, 16);
        if(size === 0) {
            packetLines.push({ type: 'flush' });
            i += 4;
        } else {
            packetLines.push({
                type: 'data',
                payload: buffer.subarray(i + 4, i + size),
            });
            i += size;
        }
    }
    return packetLines;
}

export interface GitPack {
    type: string;
    objects: GitObject[];
    version: number;
}
export async function readPack(pack: Buffer): Promise<GitPack> {
    let offset = 0;
    const type = pack.toString('utf-8', offset, offset += 4);
    const version = pack.readUInt32BE(offset);
    offset += 4;
    const nObjects = pack.readUInt32BE(offset);
    offset += 4;

    const objects = new Array<GitObject>(nObjects);
    for(let i=0;i<nObjects;i++) {
        const object = await readObject(pack, offset);
        objects[i] = object;
        offset = object.end;
    }
    return { type, objects, version };
}

export const objectTypeNameById: Record<number, string> = {
    1: 'commit',
    2: 'tree',
    3: 'blob',
    4: 'tag',
    6: 'ofs_delta',
    7: 'ref_delta',
};

export interface GitObject {
    objectId: Buffer;
    objectType: number;
    size: number;
    content: Buffer;
};
export async function readObject(buffer: Buffer, offset: number): Promise<GitObject & { end: number }> {
    let int: number;
    let objectType!: number;
    let isFirst = true;
    let i=0;
    let inflatedSize=0;
    let nextShift=0;
    // FIXME: Rewrite in bigints
    do {
        int = buffer.readUint8(offset + i);
        let usable = int & 0x7f;
        const shift = nextShift;
        if(isFirst) {
            objectType = (usable & 0xf0) >> 4;
            usable &= 0x0f;
            nextShift += 4;
        } else {
            nextShift += 7;
        }
        inflatedSize |= usable << shift;
        isFirst = false;
        i++;
    } while(int >= 0x80);

    const inflate = createInflate({ maxOutputLength: inflatedSize });
    const pendingInflated = bufferFromStream(inflate);
    inflate.end(buffer.subarray(offset + i));
    const inflated = await pendingInflated;

    const end = offset + i + inflate.bytesWritten;

    const hash = createHash('sha1');
    const objectTypeName = objectTypeNameById[objectType];
    const inflatedSizeString = inflatedSize.toString();
    const hashContent = Buffer.allocUnsafe(objectTypeName.length + inflatedSizeString.length + inflatedSize + 2);
    let hashOffset = 0;
    hashContent.write(objectTypeName);
    hashOffset += objectTypeName.length;
    hashContent.writeUint8(0x20, hashOffset++);
    hashContent.write(inflatedSizeString, hashOffset);
    hashOffset += inflatedSizeString.length;
    hashContent.writeUint8(0x00, hashOffset++);
    hashContent.set(inflated, hashOffset);
    const objectId = hash.update(hashContent).digest();

    return {
        objectId,
        objectType,
        size: inflatedSize,
        content: inflated,
        end,
    };
}

export interface GitTreeEntry {
    mode: string;
    filename: string;
    objectId: Buffer;
}
export function readTree(tree: Buffer) {
    let i=0;
    const entries: GitTreeEntry[] = [];
    while(i < tree.byteLength) {
        const len = tree.readUint8(i + 5) === 0x20 ? 5 : 6;
        const mode = tree.toString('ascii', i, i += len);
        const start = ++i;
        while(tree.readUint8(i++));
        const filename = tree.toString('ascii', start, i - 1);
        const objectId = tree.subarray(i, i += 20);
        entries.push({ mode, filename, objectId });
    }
    return entries;
}

const parent = Buffer.from('parent', 'ascii');
export interface GitCommitLinks {
    tree: string;
    parents: string[];
}
export function readCommitLinks(commit: Buffer): GitCommitLinks & { end: number } {
    const tree = commit.toString('ascii', 5, 45);
    const parents: string[] = [];
    let offset = 46;
    while(parent.compare(commit, offset, offset + 6) === 0) {
        parents.push(commit.toString('ascii', offset + 7, offset + 47));
        offset += 48;
    }
    return {
        tree,
        parents,
        end: offset,
    };
}

export function readResponse(buffer: Buffer) {
    const packetLines = readPacketLines(buffer);
    const dataBuffers = packetLines.flatMap((packetLine) => {
        if(packetLine.type === 'data') {
            const { payload } = packetLine;
            const band = payload.readUint8();
            if(band === 1) {
                return payload.subarray(1);
            }
        }
        return [];
    });
    const objectData = Buffer.concat(dataBuffers);
    return readPack(objectData);
}
