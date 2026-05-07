import React, { useState, useEffect, useRef, useCallback } from 'react';

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, serverTimestamp } from 'firebase/firestore';
import { Bold, Underline, Plus, Trash2, Menu, Type, AlertCircle, Settings, X, Copy, Check } from 'lucide-react';

const rawFirebaseConfig = import.meta.env.VITE_FIREBASE_CONFIG;
const firebaseConfig = rawFirebaseConfig ? JSON.parse(rawFirebaseConfig) : null;
const app = firebaseConfig ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const appId = import.meta.env.VITE_APP_ID || 'default-app-id';
const initialAuthToken = import.meta.env.VITE_INITIAL_AUTH_TOKEN || '';

// ── 환영 화면 ────────────────────────────────────────────────────────────────
const WelcomeScreen = ({ onGuest, onGoogleSync }) => (
  <div className="h-screen flex flex-col items-center justify-center bg-white px-6">
    <div className="w-full max-w-sm flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3">
        <div className="w-12 h-12 bg-black text-white flex items-center justify-center rounded-xl text-2xl font-bold tracking-tighter">b</div>
        <div>
          <h1 className="text-3xl font-bold tracking-tighter text-center">bnote</h1>
          <p className="text-sm text-gray-400 text-center mt-1">생각을 구조화하는 가장 빠른 방법</p>
        </div>
      </div>
      <div className="w-full bg-gray-50 rounded-2xl p-5 space-y-2.5 text-sm text-gray-500">
        {[['•', '불렛 기반 구조화 메모'], ['⇥', 'Tab / Shift+Tab 으로 들여쓰기'], ['✦', '커스텀 불렛 · 번호 목록'], ['☁', '실시간 클라우드 동기화']].map(([icon, label]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="w-5 text-center text-gray-400 font-mono text-xs">{icon}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="w-full flex flex-col gap-3">
        <button onClick={onGuest} className="w-full py-3 bg-black text-white rounded-xl font-semibold text-sm hover:bg-gray-800 active:scale-[0.98] transition-all">
          체험해보기 →
        </button>
        <button onClick={onGoogleSync} className="w-full py-2.5 border border-gray-200 rounded-xl text-sm text-gray-500 hover:bg-gray-50 active:scale-[0.98] transition-all">
          구글로 로그인하고 동기화
        </button>
      </div>
      <p className="text-[11px] text-gray-300 text-center">체험판은 새로고침 시 초기화됩니다</p>
    </div>
  </div>
);

// ── 상수 ─────────────────────────────────────────────────────────────────────
const DEFAULT_BULLETS = ['•', '○', '■', '□', '◆', '▲', '★', '✅'];

const LIST_TYPES = [
  { type: 'decimal-dot',     preview: '1.' },
  { type: 'decimal-paren',   preview: '1)' },
  { type: 'decimal-bracket', preview: '[1]' },
];

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const getListNumber = (items, index) => {
  const item = items[index];
  if (!item.listType) return null;
  let count = 1;
  for (let i = index - 1; i >= 0; i--) {
    const prev = items[i];
    if (prev.depth > item.depth) continue;
    if (prev.depth < item.depth) break;
    if (prev.listType === item.listType) count++;
    else break;
  }
  return count;
};

const formatListLabel = (listType, num) => {
  if (listType === 'decimal-dot')     return `${num}.`;
  if (listType === 'decimal-paren')   return `${num})`;
  if (listType === 'decimal-bracket') return `[${num}]`;
  return `${num}.`;
};

// HTML → 마크다운 텍스트
const stripHtml = (html) => {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<u>(.*?)<\/u>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
};

// 불렛 기호 통일 범위: 빈 줄 또는 상위 위계를 만나면 멈춤
const getBulletGroup = (items, targetIndex) => {
  const depth = items[targetIndex].depth;
  const isBlank = (item) => !stripHtml(item.content || '');
  const group = new Set([targetIndex]);

  for (let i = targetIndex - 1; i >= 0; i--) {
    if (items[i].depth > depth) continue;  // 하위 항목 건너뜀
    if (items[i].depth < depth) break;     // 상위 위계 도달 → 중단
    if (isBlank(items[i])) break;          // 빈 줄(문단 경계) → 중단
    group.add(i);
  }
  for (let i = targetIndex + 1; i < items.length; i++) {
    if (items[i].depth > depth) continue;
    if (items[i].depth < depth) break;
    if (isBlank(items[i])) break;
    group.add(i);
  }
  return group;
};

// ── 불렛 기호 관리 모달 ───────────────────────────────────────────────────────
const BulletSettingsModal = ({ bullets, onAdd, onRemove, onReset, onClose }) => {
  const [newBullet, setNewBullet] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleAdd = () => {
    const val = newBullet.trim();
    if (!val || bullets.includes(val)) return;
    onAdd(val);
    setNewBullet('');
    inputRef.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-80 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b">
          <h2 className="font-bold text-sm">불렛 기호 목록 관리</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={15} className="text-gray-400" />
          </button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto">
          <p className="text-xs text-gray-400 mb-4 leading-relaxed">
            불렛 팝업에 표시될 기호 목록입니다.<br />
            기호에 마우스를 올리면 × 버튼이 나타납니다.
          </p>

          {/* 기호 그리드 */}
          <div className="flex flex-wrap gap-2 mb-5 min-h-[2.5rem]">
            {bullets.map((char, i) => (
              <div key={`${char}-${i}`} className="group relative">
                <div className="w-10 h-10 flex items-center justify-center border border-gray-200 rounded-xl text-lg bg-gray-50 select-none">
                  {char}
                </div>
                <button
                  onClick={() => onRemove(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-400 text-white rounded-full text-[10px] opacity-0 group-hover:opacity-100 flex items-center justify-center leading-none transition-opacity"
                  title="제거"
                >
                  ×
                </button>
              </div>
            ))}
            {bullets.length === 0 && (
              <p className="text-xs text-gray-300 self-center">아래에서 기호를 추가하세요.</p>
            )}
          </div>

          {/* 새 기호 추가 */}
          <div className="flex gap-2 pt-4 border-t">
            <input
              ref={inputRef}
              value={newBullet}
              onChange={e => setNewBullet(e.target.value.slice(0, 3))}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleAdd(); }}
              placeholder="이모지·기호 입력 (Enter)"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-gray-400 transition-colors"
            />
            <button
              onClick={handleAdd}
              disabled={!newBullet.trim()}
              className="px-3 py-2 bg-black text-white rounded-lg text-sm hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              추가
            </button>
          </div>
        </div>

        {/* 푸터 */}
        <div className="flex justify-between items-center px-5 py-3.5 border-t">
          <button onClick={onReset} className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors">
            기본값으로 초기화
          </button>
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs transition-colors">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
};

// ── NoteItem ──────────────────────────────────────────────────────────────────
const NoteItem = ({
  item, index, listNumber, customBullets,
  onUpdate, onDelete, onEnter, onIndent, onOutdent,
  onBulletChange, onAutoConvert,
  focusedId,
}) => {
  const contentRef     = useRef(null);
  const isComposingRef = useRef(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    if (contentRef.current && contentRef.current.innerHTML !== item.content) {
      contentRef.current.innerHTML = item.content;
    }
  }, [item.id]);

  useEffect(() => {
    if (focusedId === item.id && contentRef.current) {
      contentRef.current.focus();
      const range = document.createRange();
      const sel   = window.getSelection();
      range.selectNodeContents(contentRef.current);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [focusedId, item.id]);

  const handleKeyDown = (e) => {
    const nativeEvent = e.nativeEvent;
    const isComposing = isComposingRef.current || nativeEvent?.isComposing || nativeEvent?.keyCode === 229;

    if (e.key === 'Enter') {
      if (isComposing) return;
      e.preventDefault();
      onEnter(index, item.depth, item.bulletChar, item.listType);

    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.shiftKey ? onOutdent(item.id) : onIndent(item.id);

    } else if (e.key === ' ' && !isComposing) {
      // ── 자동 변환: - / 1. / 1) / [1] + Space
      const text = contentRef.current.innerText.trim();
      let matchedType = null;
      if (text === '-')    matchedType = 'bullet';
      else if (text === '1.')    matchedType = 'decimal-dot';
      else if (text === '1)')    matchedType = 'decimal-paren';
      else if (text === '[1]')   matchedType = 'decimal-bracket';

      if (matchedType) {
        e.preventDefault();
        contentRef.current.innerHTML = '';
        onAutoConvert(item.id, matchedType);
        return;
      }

    } else if (e.key === 'Backspace') {
      const isEmpty = contentRef.current.innerText === '' || contentRef.current.innerHTML === '<br>';
      if (!isEmpty) return;
      e.preventDefault();
      if (item.depth > 0) {
        // ① 들여쓰기 있으면 → 내어쓰기
        onOutdent(item.id);
      } else if (item.bulletChar || item.listType) {
        // ② 최상위 + 기호 있음 → 기호만 제거 (줄 유지)
        onUpdate(item.id, { bulletChar: '', listType: null });
      } else {
        // ③ 최상위 + 기호 없음 → 줄 삭제
        onDelete(item.id, index);
      }
    }
  };

  const label = item.listType ? formatListLabel(item.listType, listNumber ?? 1) : null;

  return (
    <div
      className="group flex items-start gap-1"
      style={{ marginLeft: `${item.depth * 28}px`, breakInside: 'avoid' }}
    >
      {/* 불렛 버튼 */}
      <div className="relative mt-1 flex-shrink-0">
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="h-7 min-w-[1.75rem] px-0.5 flex items-center justify-center rounded hover:bg-gray-100 text-gray-700"
        >
          {label ? (
            <span className="text-xs font-mono text-gray-500 leading-none whitespace-nowrap">{label}</span>
          ) : item.bulletChar ? (
            <span className="font-bold">{item.bulletChar}</span>
          ) : (
            <Type size={14} className="text-gray-300" />
          )}
        </button>

        {isMenuOpen && (
          <div className="absolute left-0 top-8 z-50 bg-white border border-gray-100 shadow-2xl rounded-xl p-3 w-48">
            {/* 불렛 프리셋 */}
            <p className="text-[10px] text-gray-400 mb-1.5">불렛 기호</p>
            {customBullets.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-3">
                {customBullets.map((char, i) => (
                  <button
                    key={`${char}-${i}`}
                    onClick={() => { onBulletChange(item.id, item.depth, char, null); setIsMenuOpen(false); }}
                    className={`w-7 h-7 rounded text-base hover:bg-blue-50 transition-colors ${
                      item.bulletChar === char && !item.listType ? 'bg-blue-100 ring-1 ring-blue-300' : ''
                    }`}
                  >
                    {char}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-gray-300 mb-3">기호 없음 — 설정에서 추가하세요</p>
            )}

            {/* 번호 목록 */}
            <div className="border-t border-gray-100 pt-2.5 mb-2">
              <p className="text-[10px] text-gray-400 mb-1.5">번호 목록</p>
              <div className="flex gap-1">
                {LIST_TYPES.map(({ type, preview }) => (
                  <button
                    key={type}
                    onClick={() => { onBulletChange(item.id, item.depth, '', type); setIsMenuOpen(false); }}
                    className={`flex-1 py-1.5 text-xs rounded-lg font-mono border transition-all ${
                      item.listType === type
                        ? 'bg-black text-white border-black'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {preview}
                  </button>
                ))}
              </div>
            </div>

            {/* 제거 */}
            {(item.bulletChar || item.listType) && (
              <button
                onClick={() => { onUpdate(item.id, { bulletChar: '', listType: null }); setIsMenuOpen(false); }}
                className="w-full py-1 text-[10px] text-gray-400 hover:bg-gray-100 rounded-lg transition-colors"
              >
                기호 제거
              </button>
            )}

            <div className="fixed inset-0 -z-10" onClick={() => setIsMenuOpen(false)} />
          </div>
        )}
      </div>

      {/* 본문 (contentEditable) */}
      <div
        ref={contentRef}
        contentEditable
        suppressContentEditableWarning
        onCompositionStart={() => { isComposingRef.current = true; }}
        onCompositionEnd={() => { isComposingRef.current = false; }}
        onInput={() => onUpdate(item.id, { content: contentRef.current.innerHTML })}
        onKeyDown={handleKeyDown}
        className="flex-1 outline-none py-1.5 min-h-[1.5em] whitespace-pre-wrap break-words text-gray-800"
        placeholder={index === 0 ? '기록을 시작하세요...' : ''}
      />

      <button
        onClick={() => onDelete(item.id, index)}
        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1.5 text-gray-300 hover:text-red-400 transition-opacity"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
};

// ── 노트 생성 헬퍼 ───────────────────────────────────────────────────────────
const newBlankNote = (title = '제목 없는 노트') => ({
  id: Math.random().toString(36).substr(2, 9),
  title,
  columns: 1,
  items: [{ id: Math.random().toString(36).substr(2, 9), content: '', depth: 0, bulletChar: '•', listType: null }],
});

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode]               = useState('welcome');
  const [user, setUser]               = useState(null);
  const [authError, setAuthError]     = useState('');
  const [notes, setNotes]             = useState([]);
  const [activeNoteId, setActiveNoteId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusedId, setFocusedId]     = useState(null);
  const [isSaving, setIsSaving]       = useState(false);
  const [isSettingsOpen, setIsSettingsOpen]           = useState(false);
  const [isBulletSettingsOpen, setIsBulletSettingsOpen] = useState(false);
  const [copied, setCopied]           = useState(false);

  // 불렛 기호 목록 (localStorage 영속)
  const [customBullets, setCustomBullets] = useState(() => {
    try {
      const saved = localStorage.getItem('bnote-custom-bullets');
      return saved ? JSON.parse(saved) : [...DEFAULT_BULLETS];
    } catch { return [...DEFAULT_BULLETS]; }
  });

  useEffect(() => {
    localStorage.setItem('bnote-custom-bullets', JSON.stringify(customBullets));
  }, [customBullets]);

  // ── 모드 진입 ──────────────────────────────────────────────────────────────
  const enterGuest = () => {
    const note = newBlankNote('체험 노트');
    setNotes([note]);
    setActiveNoteId(note.id);
    setMode('guest');
  };

  const enterGoogleSync = async () => {
    if (!firebaseConfig) { alert('Firebase 설정이 없습니다. .env 파일을 확인해주세요.'); return; }
    if (!auth) { setAuthError('Firebase Auth 초기화 실패.'); return; }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      setAuthError('');
      setMode('app');
    } catch (err) {
      console.error(err);
      setAuthError('구글 로그인에 실패했습니다.');
    }
  };

  // ── Firebase 인증 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'app') return;
    let alive = true;
    (async () => {
      try {
        if (!auth?.currentUser) {
          if (initialAuthToken) await signInWithCustomToken(auth, initialAuthToken);
          else await signInAnonymously(auth);
        }
        if (alive) setAuthError('');
      } catch (err) {
        console.error(err);
        if (!alive) return;
        setAuthError('Firebase 인증 설정을 확인해주세요.');
        setMode('guest');
      }
    })();
    const unsub = onAuthStateChanged(auth, setUser);
    return () => { alive = false; unsub(); };
  }, [mode]);

  // ── Firestore 실시간 동기화 ───────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'app' || !user) return;
    const ref = collection(db, 'artifacts', appId, 'users', user.uid, 'notes');
    return onSnapshot(ref, (snap) => {
      const data = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(n => !n.isDeleted)
        .sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
      setNotes(data);
      if (!activeNoteId && data.length > 0) setActiveNoteId(data[0].id);
    });
  }, [mode, user]);

  const activeNote = notes.find(n => n.id === activeNoteId);

  const sync = useCallback(async (data) => {
    if (mode !== 'app' || !user || !activeNoteId) return;
    setIsSaving(true);
    await setDoc(
      doc(db, 'artifacts', appId, 'users', user.uid, 'notes', activeNoteId),
      { ...data, updatedAt: serverTimestamp() },
      { merge: true }
    );
    setIsSaving(false);
  }, [mode, user, activeNoteId]);

  useEffect(() => {
    if (!activeNote || mode === 'guest') return;
    const t = setTimeout(() => sync(activeNote), 1000);
    return () => clearTimeout(t);
  }, [activeNote?.items, activeNote?.title, activeNote?.columns]);

  // ── 노트 CRUD ─────────────────────────────────────────────────────────────
  const createNote = async () => {
    if (mode === 'guest') {
      const note = newBlankNote();
      setNotes(prev => [note, ...prev]);
      setActiveNoteId(note.id);
      return;
    }
    if (!user) return;
    const note = newBlankNote();
    await setDoc(
      doc(db, 'artifacts', appId, 'users', user.uid, 'notes', note.id),
      { ...note, isDeleted: false, updatedAt: serverTimestamp() }
    );
    setActiveNoteId(note.id);
  };

  const updateNote  = (u) => setNotes(prev => prev.map(n => n.id === activeNoteId ? { ...n, ...u } : n));
  const updateItems = (items) => setNotes(prev => prev.map(n => n.id === activeNoteId ? { ...n, items } : n));

  const addItem = (i, d, c, lt) => {
    const id = Math.random().toString(36).substr(2, 9);
    const next = [...activeNote.items];
    next.splice(i + 1, 0, { id, content: '', depth: d, bulletChar: c || '', listType: lt || null });
    updateItems(next);
    setFocusedId(id);
  };

  const deleteItem = (id, i) => {
    if (activeNote.items.length <= 1) return;
    updateItems(activeNote.items.filter(it => it.id !== id));
    if (i > 0) setFocusedId(activeNote.items[i - 1].id);
  };

  // ── 불렛 변경: 같은 문단 + 같은 위계만 일괄 적용 ─────────────────────────
  const handleBulletChange = (id, depth, bulletChar, listType) => {
    const idx   = activeNote.items.findIndex(it => it.id === id);
    const group = getBulletGroup(activeNote.items, idx); // 문단 범위

    updateItems(activeNote.items.map((it, i) => {
      const isTarget    = it.id === id;
      const inGroup     = group.has(i);
      const sameDepth   = it.depth === depth;

      if (listType) {
        if (isTarget || (inGroup && sameDepth && it.listType)) {
          return { ...it, bulletChar: '', listType };
        }
      } else if (bulletChar) {
        if (isTarget || (inGroup && sameDepth && it.bulletChar)) {
          return { ...it, bulletChar, listType: null };
        }
      }
      return it;
    }));
  };

  // ── 자동 변환 (- / 1. / 1) / [1] + Space) ────────────────────────────────
  const handleAutoConvert = (id, matchedType) => {
    if (matchedType === 'bullet') {
      const firstBullet = customBullets[0] || '•';
      updateItems(activeNote.items.map(it =>
        it.id === id ? { ...it, bulletChar: firstBullet, listType: null } : it
      ));
    } else {
      updateItems(activeNote.items.map(it =>
        it.id === id ? { ...it, bulletChar: '', listType: matchedType } : it
      ));
    }
  };

  // ── 마크다운 전체 복사 ────────────────────────────────────────────────────
  const copyAsMarkdown = async () => {
    if (!activeNote) return;
    const lines = [`# ${activeNote.title}`, ''];
    activeNote.items.forEach((item, i) => {
      const indent = '  '.repeat(item.depth);
      const text   = stripHtml(item.content);
      const num    = getListNumber(activeNote.items, i);
      let prefix   = '';
      if (item.listType)    prefix = formatListLabel(item.listType, num ?? 1) + ' ';
      else if (item.bulletChar) prefix = '- ';
      lines.push(indent + prefix + text);
    });
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── 렌더 분기 ─────────────────────────────────────────────────────────────
  if (mode === 'welcome') return <WelcomeScreen onGuest={enterGuest} onGoogleSync={enterGoogleSync} />;
  if (mode === 'app' && !user) return (
    <div className="h-screen flex items-center justify-center text-gray-400 text-sm">인증 중...</div>
  );
  if (!activeNote) return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 text-gray-400">
      <p className="text-sm">노트가 없습니다.</p>
      <button onClick={createNote} className="px-4 py-2 bg-black text-white rounded-lg text-sm hover:bg-gray-800">
        새 노트 만들기
      </button>
    </div>
  );

  const columns = activeNote.columns ?? 1;

  return (
    <div className="flex h-screen bg-white font-sans overflow-hidden">
      {/* ── 사이드바 ──────────────────────────────────────────────────────── */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} bg-[#fbfbfa] border-r transition-all duration-300 flex flex-col overflow-hidden flex-shrink-0`}>
        <div className="p-4 font-bold tracking-tighter text-xl border-b flex items-center gap-2">
          <div className="w-6 h-6 bg-black text-white flex items-center justify-center rounded text-xs">b</div>
          bnote
          {mode === 'guest' && (
            <span className="ml-auto text-[10px] font-normal bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">체험판</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {notes.map(n => (
            <div key={n.id} onClick={() => setActiveNoteId(n.id)}
              className={`px-3 py-2 rounded-lg cursor-pointer text-sm mb-1 ${
                activeNoteId === n.id ? 'bg-gray-200 font-bold' : 'hover:bg-gray-100 text-gray-500'
              }`}
            >
              {n.title || '제목 없음'}
            </div>
          ))}
        </div>
        <div className="p-3 border-t">
          <button onClick={createNote} className="w-full flex items-center justify-center gap-1 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">
            <Plus size={14} /> 새 노트
          </button>
        </div>
        <div className="px-4 pb-3 text-[10px] text-gray-400 flex justify-between items-center">
          {mode === 'guest' ? (
            <>
              <span className="flex items-center gap-1 text-amber-500"><AlertCircle size={10} /> 저장 안 됨</span>
              <button onClick={enterGoogleSync} className="text-blue-500 hover:underline">구글 로그인</button>
            </>
          ) : (
            <>
              <span>ID: {user?.uid.slice(0, 6)}</span>
              {isSaving ? <span className="text-blue-500">동기화 중...</span> : <span>저장 완료</span>}
            </>
          )}
        </div>
      </aside>

      {/* ── 메인 ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0">
        {authError && (
          <div className="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{authError}</div>
        )}

        {/* 툴바 */}
        <header className="h-12 border-b flex items-center px-4 gap-1 flex-shrink-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 hover:bg-gray-100 rounded">
            <Menu size={18} />
          </button>
          <div className="h-4 w-px bg-gray-200 mx-1" />
          <button onMouseDown={e => { e.preventDefault(); document.execCommand('bold'); }}
            className="p-1.5 hover:bg-gray-100 rounded">
            <Bold size={16} />
          </button>
          <button onMouseDown={e => { e.preventDefault(); document.execCommand('underline'); }}
            className="p-1.5 hover:bg-gray-100 rounded">
            <Underline size={16} />
          </button>

          <div className="h-4 w-px bg-gray-200 mx-1" />

          {/* 마크다운 전체 복사 */}
          <button
            onClick={copyAsMarkdown}
            title="마크다운으로 전체 복사"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-all ${
              copied ? 'bg-green-50 text-green-600' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            {copied ? <><Check size={13} /> 복사됨</> : <><Copy size={13} /> MD 복사</>}
          </button>

          {/* 페이지 설정 */}
          <div className="relative ml-auto">
            <button
              onClick={() => { setIsSettingsOpen(!isSettingsOpen); }}
              className={`p-1.5 rounded transition-colors ${isSettingsOpen ? 'bg-gray-100' : 'hover:bg-gray-100'}`}
            >
              <Settings size={16} className="text-gray-500" />
            </button>

            {isSettingsOpen && (
              <div className="absolute right-0 top-9 z-40 bg-white border border-gray-100 shadow-2xl rounded-xl p-4 w-52">
                <p className="text-[10px] text-gray-400 font-medium mb-3">페이지 설정</p>

                {/* 레이아웃 */}
                <div className="mb-4">
                  <p className="text-xs text-gray-500 mb-2">레이아웃</p>
                  <div className="flex gap-1.5">
                    {[1, 2].map(col => (
                      <button key={col} onClick={() => { updateNote({ columns: col }); setIsSettingsOpen(false); }}
                        className={`flex-1 py-2 text-xs rounded-lg border transition-all ${
                          columns === col ? 'bg-black text-white border-black' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {col}단
                      </button>
                    ))}
                  </div>
                </div>

                {/* 불렛 기호 관리 */}
                <div className="border-t pt-3">
                  <button
                    onClick={() => { setIsSettingsOpen(false); setIsBulletSettingsOpen(true); }}
                    className="w-full py-2 text-xs text-gray-500 hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
                  >
                    불렛 기호 목록 관리 →
                  </button>
                </div>

                <div className="fixed inset-0 -z-10" onClick={() => setIsSettingsOpen(false)} />
              </div>
            )}
          </div>

          {/* 체험판 배너 */}
          {mode === 'guest' && (
            <div className="flex items-center gap-2 text-xs text-amber-500 ml-2">
              <AlertCircle size={13} />
              <span className="hidden sm:inline">체험판 · 새로고침 시 초기화</span>
              <button onClick={enterGoogleSync} className="ml-1 px-2.5 py-1 bg-black text-white rounded-md text-[11px] hover:bg-gray-800">
                구글 로그인
              </button>
            </div>
          )}
        </header>

        {/* 콘텐츠 스크롤 영역 */}
        <div
          className={`flex-1 overflow-y-auto pt-20 pb-64 ${
            columns === 2 ? 'px-6 sm:px-10 md:px-16' : 'px-6 sm:px-12 md:px-24 lg:px-48 xl:px-64'
          }`}
        >
          {/* 제목 */}
          <input
            className="w-full text-4xl font-bold mb-12 outline-none bg-transparent"
            value={activeNote.title}
            onChange={e => setNotes(notes.map(n => n.id === activeNoteId ? { ...n, title: e.target.value } : n))}
          />

          {/* 항목 목록 — user-select: text 로 드래그 복사 보장 */}
          <div
            className="space-y-0.5"
            style={{
              ...(columns === 2 ? { columnCount: 2, columnGap: '2.5rem' } : {}),
              userSelect: 'text',
            }}
          >
            {activeNote.items.map((item, i) => (
              <NoteItem
                key={item.id}
                item={item}
                index={i}
                listNumber={getListNumber(activeNote.items, i)}
                customBullets={customBullets}
                onUpdate={(id, up) =>
                  updateItems(activeNote.items.map(it => it.id === id ? { ...it, ...up } : it))
                }
                onDelete={deleteItem}
                onEnter={addItem}
                onIndent={id => updateItems(activeNote.items.map(it =>
                  it.id === id ? { ...it, depth: Math.min(5, it.depth + 1) } : it
                ))}
                onOutdent={id => updateItems(activeNote.items.map(it =>
                  it.id === id ? { ...it, depth: Math.max(0, it.depth - 1) } : it
                ))}
                onBulletChange={handleBulletChange}
                onAutoConvert={handleAutoConvert}
                focusedId={focusedId}
              />
            ))}
          </div>
        </div>
      </main>

      {/* ── 불렛 기호 관리 모달 ───────────────────────────────────────────── */}
      {isBulletSettingsOpen && (
        <BulletSettingsModal
          bullets={customBullets}
          onAdd={char => setCustomBullets(prev => [...prev, char])}
          onRemove={i => setCustomBullets(prev => prev.filter((_, idx) => idx !== i))}
          onReset={() => setCustomBullets([...DEFAULT_BULLETS])}
          onClose={() => setIsBulletSettingsOpen(false)}
        />
      )}
    </div>
  );
}
