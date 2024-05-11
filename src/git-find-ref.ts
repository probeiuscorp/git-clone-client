import { GitInfoRequest, MakeRequest } from './git-clone-client';
import { readPacketLines } from './git-objects';

export function findCommitOfRefInAdvertisement(buffer: Buffer, ref: Buffer) {
    let hasFlush = false;
    let isFirst = true;
    const length = ref.byteLength;
    for(const line of readPacketLines(buffer)) {
        if(line.type === 'flush') {
            hasFlush = true;
        } else if(hasFlush) {
            if(isFirst) {
                isFirst = false;
            } else {
                const { payload } = line;
                const sorting = ref.compare(payload, 41, 41 + length);
                if(sorting === 0) {
                    return payload.toString('ascii', 0, 40);
                }
            }
        }
    }
    return undefined;
}

export async function maybeFindCommitOfRef(ref: string, makeRequest: MakeRequest<GitInfoRequest>) {
    const advertisement = await makeRequest({ type: 'req-info' });
    return findCommitOfRefInAdvertisement(advertisement, Buffer.from(ref, 'ascii'));
}

export async function findCommitOfRef(ref: string, makeRequest: MakeRequest<GitInfoRequest>) {
    const commit = await maybeFindCommitOfRef(ref, makeRequest);
    if(commit === undefined) {
        throw new Error(`Could not find ref "${ref}"`);
    }
    return commit;
}
