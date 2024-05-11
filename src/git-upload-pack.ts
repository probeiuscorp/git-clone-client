import { GitRequest, GitUploadPackRequest, MakeRequest } from './git-clone-client';
import { GitPacketLine, GitTreeEntry, readCommitLinks, readPack, readPacketLines, readTree } from './git-objects';

function filterLinesContainingPacks(lines: GitPacketLine[]): Buffer[] {
    let isData = false;
    const dataLines: Buffer[] = [];
    for(const line of lines) {
        if(!isData) {
            if(line.type === 'data') {
                if(line.payload.toString('ascii', 1, 5) === 'PACK') {
                    dataLines.push(line.payload.subarray(1));
                    isData = true;
                }
            }
        } else {
            if(line.type === 'flush') {
                break;
            } else {
                dataLines.push(line.payload.subarray(1));
            }
        }
    };
    return dataLines;
}

const capabilities = `multi_ack_detailed no-done no-progress side-band-64k thin-pack deepen-since deepen-not filter`;
const doneLine = '00000008done';
function formatLine(line: string) {
    return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}
export const isGitModeDirectory = (mode: string) => mode[0] === '4';

export interface ShallowCloneCommitOptions<T extends GitRequest = GitUploadPackRequest> {
    makeRequest: MakeRequest<T>;
    filter?: (filepath: string, isDirectory: boolean, depth: number, filename: string) => boolean;
}
export async function shallowCloneCommit(commit: string, { makeRequest, filter }: ShallowCloneCommitOptions) {
    const readResponse = (packResponse: Buffer) =>
        Buffer.concat(filterLinesContainingPacks(readPacketLines(packResponse)));
    const requestAndReadPackFile = (request: string) =>
        makeRequest({ type: 'upload-pack', body: request }).then(readResponse).then(readPack);

    const commitTreeRequest = formatLine(`want ${commit} ${capabilities}`)
        + formatLine('deepen 1')
        + formatLine('filter tree:0')
        + doneLine;
    const commitPack = await requestAndReadPackFile(commitTreeRequest);
    const { tree } = readCommitLinks(commitPack.objects[0].content);
    const treesPackRequest = formatLine(`want ${tree} ${capabilities}`)
        + formatLine(`shallow ${commit}`)
        + formatLine('filter blob:none')
        + doneLine;
    const treesPack = await requestAndReadPackFile(treesPackRequest);

    const trees = new Map<string, GitTreeEntry[]>();
    const blobFilenames = new Map<string, string>();
    const parsedTrees = treesPack.objects.map(({ objectId, content }) => ({
        objectId,
        entries: readTree(content),
    }));
    parsedTrees.forEach((object) => {
        trees.set(object.objectId, object.entries);
    });
    const desiredObjectIds: string[] = [];
    function visit(entries: GitTreeEntry[], dirpath: string, depth: number) {
        entries.forEach((entry) => {
            const { filename, objectId } = entry;
            const filepath = dirpath ? `${dirpath}/${filename}` : filename;
            const isDirectory = isGitModeDirectory(entry.mode);
            if(isDirectory) {
                const tree = trees.get(objectId);
                if(!tree) throw new Error(`Bogus response from server: "${objectId}" was not included in pack response`);
                visit(tree, filepath, depth + 1);
            } else if(filter === undefined || filter(filepath, isDirectory, depth, filename)) {
                blobFilenames.set(objectId, filepath);
                desiredObjectIds.push(objectId);
            }
        });
    }
    visit(parsedTrees[0].entries, '', 0);

    desiredObjectIds[0] += ' ' + capabilities;
    const filesPackRequest = desiredObjectIds.reduce((formatted, objectId) => {
        return formatted + formatLine(`want ${objectId}`);
    }, '')
        + formatLine(`shallow ${commit}`)
        + formatLine('filter blob:none')
        + doneLine;
    const filesPack = await requestAndReadPackFile(filesPackRequest);
    return filesPack.objects.map(({ objectId, content }) => {
        const filepath = blobFilenames.get(objectId);
        if(filepath === undefined) {
            throw new Error(`Bogus response from server: Extraneous object "${objectId}" included in pack`);
        }
        return { content, filepath };
    });
}
