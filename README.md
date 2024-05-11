# git-clone-client
> No dependency, no file-system Git shallow clone client for Node.js

```js
import { shallowCloneRef, httpFetchUsing } from 'git-clone-client';

async function handleRequest(req, res) {
    const files = await shallowCloneRef('refs/heads/main', {
        // Provide fetching method
        makeRequest: fetchRepository(req.query.url),
        // Partial clone -- only fetch files in the src/ directory
        filter: (filepath) => filepath.startsWith('src/'),
    });
}
// Use conveniently provided HTTP util, in this case with your environment's fetch method.
// Write your own to request over git://, ssh:// or whatever!
const fetchRepository = httpFetchUsing(fetch);
```

> [!NOTE]
> This package depends on node:zlib, node:crypto and node:buffer.
> To use different packages, fork and change imports of `src/git-objects.ts`.
