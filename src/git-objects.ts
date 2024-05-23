import { createInflate } from 'node:zlib';
import { buffer as bufferFromStream } from 'node:stream/consumers';
import { createHash } from 'node:crypto';

export const enum GitObjectTypeID {
    COMMIT = 1,
    TREE = 2,
    BLOB = 3,
    TAG = 4,
    OFS_DELTA = 6,
    REF_DELTA = 7,
};
export type GitObjectType = GitObjectTypeID.COMMIT | GitObjectTypeID.TREE |  GitObjectTypeID.BLOB | GitObjectTypeID.TAG;
export type GitPackEntryObjectType = GitObjectType | GitObjectTypeID.OFS_DELTA | GitObjectTypeID.REF_DELTA;

export const objectTypeNameById = {
    1: 'commit',
    2: 'tree',
    3: 'blob',
    4: 'tag',
    6: 'ofs_delta',
    7: 'ref_delta',
} as const satisfies Record<GitObjectTypeID, string>;
export type GitObjectTypeName = (typeof objectTypeNameById)[keyof typeof objectTypeNameById];

export interface GitObject {
    objectType: GitObjectType;
    objectId: string;
    content: Buffer;
}

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

    const objects: GitObject[] = [];
    const objectsById = new Map<string, GitObject>();
    for(let i=0;i<nObjects;i++) {
        const { objectType, inflatedSize, headerSize } = readPackObjectHeader(pack, offset);
        const data = pack.subarray(offset + headerSize);
        offset += headerSize;
        let object: GitObject;
        if(objectType === GitObjectTypeID.REF_DELTA) {
            const referenceObjectId = data.toString('hex', 0, 20);
            const { content, consumedSize } = await readDeflated(data.subarray(20), inflatedSize);
            const { instructions, reconstructedSize } = readDeltaInstructions(content);
            const baseObject = objectsById.get(referenceObjectId);
            if(baseObject === undefined) {
                throw new Error(`ref_delta referred to ${referenceObjectId}, but that object was not in the pack`);
            }
            const reconstructed = resolveDeltas(baseObject.content, instructions,  reconstructedSize);
            object = {
                objectType: baseObject.objectType,
                content: reconstructed,
                objectId: getObjectId(reconstructed, objectTypeNameById[baseObject.objectType]),
            };
            offset += 20 + consumedSize;
        } else if(objectType === GitObjectTypeID.OFS_DELTA) {
            throw new Error('Git object type ofs_delta yet not supported');
        } else {
            const { content, consumedSize } = await readDeflated(data, inflatedSize);
            const objectId = getObjectId(content, objectTypeNameById[objectType]);
            object = {
                content,
                objectType,
                objectId,
            };
            offset += consumedSize;
        }
        objects.push(object);
        objectsById.set(object.objectId, object);
    }
    return { type, objects, version };
}

export function readPackObjectHeader(buffer: Buffer, offset: number) {
    let int: number;
    let objectType!: GitPackEntryObjectType;
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

    return { objectType, inflatedSize, headerSize: i };
}

export function getObjectId(content: Buffer, objectTypeName: GitObjectTypeName) {
    const hash = createHash('sha1');
    const contentSize = content.byteLength;
    const inflatedSizeString = contentSize.toString();
    const hashContent = Buffer.allocUnsafe(objectTypeName.length + inflatedSizeString.length + contentSize + 2);
    let hashOffset = 0;
    hashContent.write(objectTypeName);
    hashOffset += objectTypeName.length;
    hashContent.writeUint8(0x20, hashOffset++);
    hashContent.write(inflatedSizeString, hashOffset);
    hashOffset += inflatedSizeString.length;
    hashContent.writeUint8(0x00, hashOffset++);
    hashContent.set(content, hashOffset);
    return hash.update(hashContent).digest('hex');
}

export async function readDeflated(buffer: Buffer, inflatedSize: number) {
    const inflate = createInflate({ maxOutputLength: inflatedSize });
    const pendingInflated = bufferFromStream(inflate);
    inflate.end(buffer);
    const content = await pendingInflated;
    const consumedSize = inflate.bytesWritten;
    return { content, consumedSize };
}

export type GitDeltaInstruction = {
    type: 'copy';
    offset: number;
    size: number;
} | {
    type: 'insert';
    data: Buffer;
};
export function readDeltaInstructions(buffer: Buffer) {
    const instructions: GitDeltaInstruction[] = [];
    let i = 0;
    // Skip size encodings
    while(buffer.readUint8(i++) >= 0x80);
    while(buffer.readUint8(i++) >= 0x80);

    let reconstructedSize = 0;
    const length = buffer.byteLength;
    while(i < length) {
        const header = buffer.readUint8(i++);
        if(header === 0) throw new Error('Delta instruction 0x00 is reserved and is not supported');
        if(header >= 0x80) {
            let offset = 0;
            let size = 0;
            if(header & 0b000_0001) offset |= buffer.readUint8(i++);
            if(header & 0b000_0010) offset |= buffer.readUint8(i++) << 8;
            if(header & 0b000_0100) offset |= buffer.readUint8(i++) << 16;
            if(header & 0b000_1000) offset |= buffer.readUint8(i++) << 24;
            if(header & 0b001_0000) size |= buffer.readUint8(i++);
            if(header & 0b010_0000) size |= buffer.readUint8(i++) << 8;
            if(header & 0b100_0000) size |= buffer.readUint8(i++) << 16;
            size ||= 0x10000;
            instructions.push({ type: 'copy', offset, size });
            reconstructedSize += size;
        } else {
            const size = header & 0x7f;
            if(size === 0) throw new Error('Delta instruction "add data" size cannot be 0');
            const data = buffer.subarray(i, i += size);
            instructions.push({ type: 'insert', data });
            reconstructedSize += size;
        }
    }
    return { reconstructedSize, instructions };
}

export function resolveDeltas(base: Buffer, instructions: Iterable<GitDeltaInstruction>, outputSize: number): Buffer {
    const output = Buffer.alloc(outputSize);
    let i = 0;
    for(const instruction of instructions) {
        if(instruction.type === 'copy') {
            const { offset, size } = instruction;
            base.copy(output, i, offset, offset + size);
            i += size;
        } else {
            const { data } = instruction;
            data.copy(output, i);
            i += data.byteLength;
        }
    }
    return output;
}


export interface GitTreeEntry {
    mode: string;
    filename: string;
    objectId: string;
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
        const objectId = tree.toString('hex', i, i += 20);
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
