import { findCommitOfRef } from './git-find-ref';
import { ShallowCloneCommitOptions, shallowCloneCommit } from './git-upload-pack';

export type GitInfoRequest = { type: 'req-info' }
export type GitUploadPackRequest = { type: 'upload-pack'; body: string }
export type GitRequest = GitInfoRequest | GitUploadPackRequest;
export type MakeRequest<T extends GitRequest = GitRequest> = (request: T) => Promise<Buffer>;

type Fetch = (url: string, initiator?: {
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Partial<Record<string, string>>;
}) => Promise<{
    // All function members are methods but not all methods are function members
    arrayBuffer(): Promise<ArrayBuffer>;
}>;
export function makeFetchLikeRequest(fetch: Fetch, url: string, request: GitRequest) {
    return (request.type === 'req-info' ? (
        fetch(`${url}/info/refs?service=git-upload-pack`)
    ) : (
        fetch(`${url}/git-upload-pack`, {
            method: 'POST',
            body: request.body,
            headers: {
                'Content-Type': 'application/x-git-upload-pack-request',
                accept: 'application/x-git-upload-pack-result',
                'Content-Length': request.body.length.toString(),
            },
        })
    )).then((res) => res.arrayBuffer()).then(Buffer.from);
};
export const httpFetchUsing = (fetch: Fetch) => (url: string): MakeRequest => (request) => makeFetchLikeRequest(fetch, url, request);

export async function shallowCloneRef(ref: string, options: ShallowCloneCommitOptions<GitRequest>) {
    const commit = await findCommitOfRef(ref, options.makeRequest);
    return await shallowCloneCommit(commit, options);
}
