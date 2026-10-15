#import "ENQueueEditor.h"
#import "ENModel.h"
#import "ENPlayback.h"

static const NSUInteger ENQueueRowCap = 32;          // the gateway's rows across q, cq and ap (§4.3)

typedef enum { ENQueueEditRemove = 0, ENQueueEditMove, ENQueueEditTop } ENQueueEditKind;

// One edit waiting to go out or for its reply: remove `row`, move it before `before` (nil = the end of its section as
// shown: -beforeFor: names the row the screen doesn't show after it, if any), or (DESIGN-QUEUE) top it (Play Next).
// `context`: the row is a "Next From" (cq) row (top: a cq or autoplay row). `after`: the shown q and cq rows once it was
// applied, what its reply must show.
@interface ENQueueEdit : NSObject
@property (nonatomic, strong) ENTrack *row, *before;
@property (nonatomic) ENQueueEditKind kind;
@property (nonatomic) BOOL context;
@property (nonatomic, copy) NSArray *after;
@end

@implementation ENQueueEdit
@end

@implementation ENQueueEditor {
	NSMutableArray *_edits;      // ENQueueEdit, oldest first: the head is out (_editOut) or about to go
	BOOL _editOut;
	NSString *_rev;              // the rev the next edit carries: the shown queue's, then each reply's (never logged)
	// the last reply's q and cq rows (ENTrack) past the ones shown: a reply at the 32-row cap lets the next row in for each
	// removal, and while edits are busy the screen doesn't show it (nil once the rows are the gateway's again, -showing:)
	NSArray *_moreQ, *_moreCQ;
	// (DESIGN-QUEUE) a topped cq / ap row's old uid -> the reply's row (its new uid): later edits made on the old row are
	// rewritten as they go out (-mapUids:); cleared by -showing:
	NSMutableDictionary *_uidMap;
}

+ (NSArray *)keysForQueued:(NSArray *)queued context:(NSArray *)context {
	NSMutableArray *keys = [NSMutableArray arrayWithCapacity:queued.count + context.count];
	for (ENTrack *t in queued) [keys addObject:[@"q:" stringByAppendingString:t.uid ?: @""]];
	for (ENTrack *t in context) [keys addObject:[@"c:" stringByAppendingString:t.uid ?: @""]];
	return keys;
}

- (id)init {
	if ((self = [super init])) {
		_edits = [NSMutableArray array];
		_uidMap = [NSMutableDictionary dictionary];
	}
	return self;
}

- (BOOL)busy {
	return _editOut || _edits.count > 0;
}

- (void)showing:(ENQueue *)q {
	_latest = q;
	_rev = [q.rev copy];
	_moreQ = nil;                              // every row the gateway sent is on screen now
	_moreCQ = nil;
	[_uidMap removeAllObjects];                // (the screens show a new queue only with no edit out or waiting)
}

- (NSString *)uidNow:(NSString *)uid {
	if (!uid) return nil;
	return ((ENTrack *)_uidMap[uid]).uid ?: uid;
}

- (void)remove:(ENTrack *)row context:(BOOL)context shown:(NSArray *)shown {
	[self enqueue:row before:nil kind:ENQueueEditRemove context:context shown:shown];
}

- (void)move:(ENTrack *)row before:(ENTrack *)before context:(BOOL)context shown:(NSArray *)shown {
	[self enqueue:row before:before kind:ENQueueEditMove context:context shown:shown];
}

- (void)top:(ENTrack *)row context:(BOOL)context shown:(NSArray *)shown {
	[self enqueue:row before:nil kind:ENQueueEditTop context:context shown:shown];
}

- (void)enqueue:(ENTrack *)row before:(ENTrack *)before kind:(ENQueueEditKind)kind context:(BOOL)context shown:(NSArray *)shown {
	ENQueueEdit *e = [ENQueueEdit new];
	e.row = row;
	e.before = before;
	e.kind = kind;
	e.context = context;
	e.after = shown;                           // the caller has already applied it to its rows
	_generation++;
	[_edits addObject:e];
	[self pump];
}

// §4.4: its q and cq rows must be the ones shown once the edit was applied (`shown`); only a reply at the 32-row cap whose
// last rows are q or cq may have more at the end.
- (BOOL)reply:(ENQueue *)q shows:(NSArray *)shown {
	if (!shown) return NO;
	NSArray *got = [ENQueueEditor keysForQueued:q.queued context:q.contextRows];
	if ([got isEqualToArray:shown]) return YES;
	BOOL capped = !q.autoplayRows.count && q.queued.count + q.contextRows.count >= ENQueueRowCap;
	return capped && got.count > shown.count && [[got subarrayWithRange:NSMakeRange(0, shown.count)] isEqualToArray:shown];
}

// "q:<old>" -> "q:<new>" in keys (a topped row is a queued row on screen from then on)
static NSArray *ENQueueKeysRenaming(NSArray *keys, NSString *old, NSString *nu) {
	if (!old.length || !nu.length || [old isEqualToString:nu]) return keys;
	NSString *from = [@"q:" stringByAppendingString:old], *to = [@"q:" stringByAppendingString:nu];
	NSMutableArray *out = [keys mutableCopy];
	for (NSUInteger i = 0; i < out.count; i++) if ([out[i] isEqualToString:from]) out[i] = to;
	return out;
}

// (DESIGN-QUEUE) an edit made on a row a top has given a new uid since: its row, its `before` and the keys its reply is
// compared with follow the reply's row
- (void)mapUids:(ENQueueEdit *)e {
	if (!_uidMap.count) return;
	ENTrack *r = e.row.uid ? _uidMap[e.row.uid] : nil;
	ENTrack *b = e.before.uid ? _uidMap[e.before.uid] : nil;
	NSArray *after = e.after;
	for (NSString *old in _uidMap) after = ENQueueKeysRenaming(after, old, ((ENTrack *)_uidMap[old]).uid);
	if (r) e.row = r;
	if (b) e.before = b;
	e.after = after;
}

// One edit out at a time, in order, each with the rev of the reply before it. The block holds self and the delegate
// strongly until it has been called (see the header).
- (void)pump {
	if (_editOut || !_edits.count) return;
	ENQueueEdit *e = _edits[0];
	[self mapUids:e];
	_editOut = YES;
	id<ENQueueEditorDelegate> owner = self.delegate;
	void (^done)(ENQueue *, NSString *, NSError *) = ^(ENQueue *q, NSString *uid, NSError *err) {
		self->_editOut = NO;
		if (!self->_edits.count || self->_edits[0] != e) {     // dropped meanwhile
			[self pump];
			return;
		}
		[self->_edits removeObjectAtIndex:0];
		if (!err) self->_latest = q;           // the newest queue the gateway confirmed (a mismatch shows it too)
		// a top: the row's uid now (a cq / ap row's new q<n> one) stands in for the old one in what the reply must show
		NSString *old = e.row.uid;
		BOOL renamed = !err && e.kind == ENQueueEditTop && uid.length && old.length && ![uid isEqualToString:old];
		if (renamed) e.after = ENQueueKeysRenaming(e.after, old, uid);
		if (err || ![self reply:q shows:e.after]) {
			[self->_edits removeAllObjects];   // the edits behind it were made on rows that are going back
			[owner queueEditor:self didFail:err];
			return;
		}
		if (renamed) for (ENTrack *t in q.queued) if ([t.uid isEqualToString:uid]) { self->_uidMap[old] = t; break; }
		self->_rev = [q.rev copy];             // no HUD: the row has already moved or gone
		[self keepRowsOf:q pastShown:e.after];
		[owner queueEditorDidApply:self];
		if (self->_edits.count) [self pump];
	};
	ENPlayback *pb = [ENPlayback shared];
	if (e.kind == ENQueueEditTop) {
		[pb topQueueRow:e.row rev:_rev done:done];
		return;
	}
	void (^edited)(ENQueue *, NSError *) = ^(ENQueue *q, NSError *err) { done(q, nil, err); };
	if (e.kind == ENQueueEditMove) [pb moveQueueRow:e.row before:[self beforeFor:e] rev:_rev done:edited];
	else [pb removeQueueRow:e.row rev:_rev done:edited];
}

// A reply that passed -reply:shows: holds the rows `shown` (its edit's `after`) and, only at the 32-row cap, more after
// them: q's past the shown q rows, cq's past the shown cq rows (with no cq row shown, every cq row is past them).
- (void)keepRowsOf:(ENQueue *)q pastShown:(NSArray *)shown {
	NSUInteger nq = 0;
	for (NSString *k in shown) if ([k hasPrefix:@"q:"]) nq++;
	NSUInteger nc = shown.count - nq;
	_moreQ = q.queued.count > nq ? [q.queued subarrayWithRange:NSMakeRange(nq, q.queued.count - nq)] : nil;
	_moreCQ = q.contextRows.count > nc ? [q.contextRows subarrayWithRange:NSMakeRange(nc, q.contextRows.count - nc)] : nil;
}

// What a move is sent to precede. A drop at the end of its section (before nil) means just after the last row on screen;
// "" (nil here) would be the end of the section the engine published, which also counts rows the screen doesn't show (a
// reply's rows past the cap, -keepRowsOf:pastShown:), so it would land after them and its reply would fail the check.
// It precedes the first of those instead; "" only when there are none (or that row has no uid).
- (ENTrack *)beforeFor:(ENQueueEdit *)e {
	if (e.before) return e.before;
	NSArray *more = e.context ? _moreCQ : _moreQ;
	ENTrack *next = more.count ? more[0] : nil;
	return next.uid.length ? next : nil;
}

@end
