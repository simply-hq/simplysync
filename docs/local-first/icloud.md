# iCloud sync (Apple apps)

A relay is one place to park an owner's encrypted event log. On Apple platforms
the Swift engine can park the **same log** in the user's own iCloud instead,
through `CloudKitTransport`. Users get sync across their iPhone, iPad, and Mac
with nothing to sign up for, and you have no server to run.

> End-to-end encryption does not change. The engine seals every event before it
> reaches iCloud, so Apple stores exactly the ciphertext a relay would, and
> neither Apple nor you can read it.

## When to use it

Use iCloud when the app is **Apple-only** and you would rather not run or pay
for a relay. It is the lowest-friction option for most iPhone users: if they
are signed in to iCloud, sync just works.

Keep a relay when the same owner must also sync with **Android, web, or CLI
clients**. Those clients cannot read a CloudKit database. You can configure
iCloud and a relay side by side; each receives a full copy of the log.

| | Relay | iCloud |
| --- | --- | --- |
| Platforms | Every client: TypeScript, Swift, Kotlin | Swift on iOS, iPadOS, and macOS |
| Who runs the storage | You, or the user's self-hosted relay | Apple, in the user's iCloud account |
| Storage limit | Per-owner relay quota, 1 GiB by default | The user's iCloud storage plan |
| Who can read the data | Nobody: ciphertext only | Nobody: ciphertext only |
| Access control | `relayAuth` bearer token from the recovery phrase | The user's Apple ID |
| Stream compaction | `POST /v1/streams/compact` | Not yet |
| Status and usage | `GET /v1/status` with quota numbers | Last sync outcome only |

## Quick start

**1. Turn on CloudKit.** In Xcode, open *Signing & Capabilities*, add
**iCloud**, tick **CloudKit**, and add a container such as
`iCloud.com.example.app`.

**2. Point the engine at iCloud.** `transportFactory` tells the engine how to
build the transport behind a `Transport(url:)` entry. The CloudKit factory
claims the `CloudKitTransport.base` entry and leaves every other entry to the
HTTP relay client.

```swift
import SimplySync

let container = "iCloud.com.example.app"
engine.transportFactory = CloudKitTransport.factory(containerIdentifier: container)

if await CloudKitTransport.accountAvailable(containerIdentifier: container) {
    engine.setTransports([Transport(url: CloudKitTransport.base)])
}
```

Set the factory **before** `setTransports`, because setting transports starts a
sync immediately. To keep Android or web clients in the loop, list a relay too:

```swift
engine.setTransports([
    Transport(url: CloudKitTransport.base),
    Transport(url: "https://relay.example.com"),
])
```

**3. Deploy the schema before you ship.** Debug builds create the record type
on their own; TestFlight and App Store builds do not. See
[Production schema](#production-schema).

## How the log is stored

| CloudKit concept | Value |
| --- | --- |
| Database | The private database of the signed-in Apple ID |
| Zone | `simplysync-<ownerId>`, one per owner |
| Record type | `SyncEvent` |
| Record name | The event's `eventId` |
| Fields | `envelope` (the JSON `SyncEnvelope`), `streamId`, `createdAt`, all strings |

It behaves like a relay at every step the engine relies on:

- **Push dedupes by event.** Records are saved with
  `.ifServerRecordUnchanged`, so an `eventId` that is already parked comes back
  as a duplicate instead of an overwrite, the same as a relay's
  `(ownerId, eventId)` dedupe. Large batches are split into operations of 400
  records, CloudKit's limit.
- **The cursor is opaque.** The zone's `CKServerChangeToken` is archived into
  the engine's string cursor, stored as `cursor:icloud`. An empty or unreadable
  cursor reads from the beginning, which is safe because applies are idempotent
  under last-writer-wins. If CloudKit expires the token, the transport re-reads
  the zone once.
- **A missing zone is an unknown owner.** Pulling before anything was pushed
  returns an empty page, like a relay's `404`. The first push creates the zone.
- **Progress is tracked per transport.** iCloud has its own `push:icloud` and
  `cursor:icloud` keys, so it and any relays advance independently. An outbox
  event is pruned only once every configured transport has acknowledged it.
- **Status comes from the last sync.** There is no `/v1/status` to probe, so
  `getRelayStatuses()` reports the `icloud` entry as reachable when its last
  pass succeeded, with no usage numbers.

To remove an owner's iCloud copy, for example behind a "Delete iCloud copy"
button, delete its zone. Local data is untouched.

```swift
try await CloudKitTransport(containerIdentifier: container, ownerId: ownerId)
    .deleteEverything()
```

## Errors

CloudKit errors are mapped onto the engine's failure kinds, so a full iCloud or
a signed-out device backs the poller off exactly as a relay's `413` or `401`
would.

| CloudKit error | Failure kind | Engine behaviour |
| --- | --- | --- |
| `notAuthenticated` | `authRejected` | Terminal: poller backs off to 5 minutes |
| `quotaExceeded` | `quotaExceeded` | Terminal: poller backs off to 5 minutes |
| `requestRateLimited`, `zoneBusy` | `rateLimited` | Backs off, not terminal |
| `serviceUnavailable`, `internalError` | `serverError` | Retries at the normal cadence |
| `missingEntitlement`, `badContainer`, `limitExceeded`, `invalidArguments`, `serverRejectedRequest` | `badRequest` | Terminal |
| Network errors and anything else | `unreachable` | Retries at the normal cadence |

A transport of your own can do the same by throwing
`SyncTransportFailure(kind:message:)`.

## Production schema

CloudKit has two environments. In **Development**, which debug builds use, the
`SyncEvent` record type is created automatically on the first save. In
**Production**, which TestFlight and App Store builds use, record types are
never created on the fly: every push from a release build fails until the
schema is deployed.

1. Run a debug build signed in to iCloud and sync once, so Development learns
   the record type. Or import this schema with `xcrun cktool import-schema`:

   ```
   DEFINE SCHEMA

       RECORD TYPE SyncEvent (
           "___createTime" TIMESTAMP,
           "___createdBy"  REFERENCE,
           "___etag"       STRING,
           "___modTime"    TIMESTAMP,
           "___modifiedBy" REFERENCE,
           "___recordID"   REFERENCE QUERYABLE,
           createdAt       STRING,
           envelope        STRING,
           streamId        STRING,
           GRANT WRITE TO "_creator",
           GRANT CREATE TO "_icloud",
           GRANT READ TO "_world"
       );
   ```

2. In [CloudKit Console](https://icloud.developer.apple.com), open the
   container and choose **Deploy Schema Changes** to copy it to Production.

Deployed fields cannot be removed later, so deploy only what the transport
writes.

## A second device without typing the phrase

The ciphertext in iCloud is useless without the owner's recovery phrase, so a
new device still needs it. iCloud Keychain can carry it there: Apple syncs
items marked synchronizable to the user's other devices, end-to-end encrypted.
This is app code, not engine API, because how a phrase is stored is the app's
decision.

```swift
// The phrase is the owner's recovery key, e.g. engine.currentOwner?.recoveryKey.
var item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.example.app",
    kSecAttrAccount as String: "recovery-phrase.icloud",
    kSecAttrSynchronizable as String: true,
]

// Device A, after the user picks iCloud:
var add = item
add[kSecValueData as String] = Data(phrase.utf8)
SecItemAdd(add as CFDictionary, nil)

// Device B, during onboarding: configure iCloud first, so the restore reads from it.
item[kSecReturnData as String] = true
var found: CFTypeRef?
if SecItemCopyMatching(item as CFDictionary, &found) == errSecSuccess,
   let data = found as? Data {
    engine.transportFactory = CloudKitTransport.factory(containerIdentifier: container)
    engine.setTransports([Transport(url: CloudKitTransport.base)])
    try await engine.restoreAppOwner(String(decoding: data, as: UTF8.self))
}
```

Be clear with users about the trade-off. With the phrase in iCloud Keychain,
anyone who gets into their Apple ID and its iCloud Keychain can open their
data. Remove the item when the user stops using iCloud sync, and keep offering
the phrase itself as a fallback.

## What Apple can see

The same metadata a relay sees, and nothing more:

- owner ids, in the zone name and in every envelope header;
- device ids, event ids with their HLC timestamps, and `createdAt`;
- `streamId`, a stable pseudonymous key per logical row;
- event counts and sizes.

Apple cannot read payloads, because the data key never leaves the user's
devices. As the developer, you cannot read a user's private database at all.
The data also counts against the user's iCloud storage, not yours.

## Limits

- **Swift only.** The TypeScript and Kotlin engines have no CloudKit transport.
- **No compaction.** Ciphertext for tombstoned rows stays in iCloud. Purging
  locally does not reclaim iCloud storage yet.
- **Polling, not push.** iCloud changes arrive on the engine's normal poll and
  on local writes. CloudKit push subscriptions are not wired up.
- **Signed-in users only.** Check `accountAvailable(containerIdentifier:)` and
  fall back to a relay, or stay local-only, when it returns `false`.

Simply Finance for iOS ships this design: an onboarding step that preselects
iCloud, a settings picker to switch between iCloud and a relay, and the iCloud
Keychain hand-off for second devices.

## Read next

- **[Sync & the relay](./sync.md)**: the sync loop and envelope this transport
  carries.
- **[Client API, Swift](./guide.swift.md)**: setting up the engine.
- **[Security](../../SECURITY.md)**: the threat model, which applies to iCloud
  exactly as it does to a relay.
