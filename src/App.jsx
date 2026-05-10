import React, { useState, useEffect, useRef, useCallback } from 'react';

import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithCustomToken, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, serverTimestamp } from 'firebase/firestore';
import { Bold, Underline, Plus, Trash2, Menu, Type, AlertCircle, Settings, X, Copy, Check, Folder, ChevronRight, ChevronDown } from 'lucide-react';

const rawFirebaseConfig = import.meta.env.VITE_FIREBASE_CONFIG;
const firebaseConfig = rawFirebaseConfig ? JSON.parse(rawFirebaseConfig) : null;
const app = firebaseConfig ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const appId = import.meta.env.VITE_APP_ID || 'default-app-id';
const initialAuthToken = import.meta.env.VITE_INITIAL_AUTH_TOKEN || '';

// ── 날짜 포맷 ─────────────────────────────────────────────────────────────────
const formatDate = (ts) => {
  if (!ts) return '';
  try {
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const diff = now - date;
    if (diff < 60_000)      return '방금 전';
    if (diff < 3_600_000)   return `${Math.floor(diff / 60_000)}분 전`;
    if (diff < 86_400_000)  return `오늘 ${date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    if (diff < 172_800_000) return '어제';
    return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  } catch { return ''; }
};

// ── 커서 위치 체크 ────────────────────────────────────────────────────────────
const isCursorAtStart = (el) => {
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const div = document.createElement('div');
    div.appendChild(pre.cloneContents());
    return div.textContent.length === 0;
  } catch { return false; }
};

const isCursorAtEnd = (el) => {
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const post = range.cloneRange();
    post.selectNodeContents(el);
    post.setStart(range.endContainer, range.endOffset);
    const div = document.createElement('div');
    div.appendChild(post.cloneContents());
    return div.textContent.length === 0;
  } catch { return false; }
};

// ── 환영 화면 ─────────────────────────────────────────────────────────────────
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

const getBulletGroup = (items, targetIndex) => {
  const depth = items[targetIndex].depth;
  const isBlank = (item) => !stripHtml(item.content || '');
  const group = new Set([targetIndex]);
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (items[i].depth > depth) continue;
    if (items[i].depth < depth) break;
    if (isBlank(items[i])) break;
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
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b">
          <h2 className="font-bold text-sm">불렛 기호 목록 관리</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={15} className="text-gray-400" />
          </button>
        </div>
        <div className="p-5 flex-1 overflow-y-auto">
          <p className="text-xs text-gray-400 mb-4 leading-relaxed">불렛 팝업에 표시될 기호 목록입니다.<br />기호에 마우스를 올리면 × 버튼이 나타납니다.</p>
          <div className="flex flex-wrap gap-2 mb-5 min-h-[2.5rem]">
            {bullets.map((char, i) => (
              <div key={`${char}-${i}`} className="group relative">
                <div className="w-10 h-10 flex items-center justify-center border border-gray-200 rounded-xl text-lg bg-gray-50 select-none">{char}</div>
                <button onClick={() => onRemove(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-400 text-white rounded-full text-[10px] opacity-0 group-hover:opacity-100 flex items-center justify-center leading-none transition-opacity">×</button>
              </div>
            ))}
            {bullets.length === 0 && <p className="text-xs text-gray-300 self-center">아래에서 기호를 추가하세요.</p>}
          </div>
          <div className="flex gap-2 pt-4 border-t">
            <input ref={inputRef} value={newBullet} onChange={e => setNewBullet(e.target.value.slice(0, 3))}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleAdd(); }}
              placeholder="이모지·기호 입력 (Enter)"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-gray-400 transition-colors" />
            <button onClick={handleAdd} disabled={!newBullet.trim()}
              className="px-3 py-2 bg-black text-white rounded-lg text-sm hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all">추가</button>
          </div>
        </div>
        <div className="flex justify-between items-center px-5 py-3.5 border-t">
          <button onClick={onReset} className="text-xs text-gray-400 hover:text-gray-600 hover:underline transition-colors">기본값으로 초기화</button>
          <button onClick={onClose} className="px-4 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-xs transition-colors">닫기</button>
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
  onMergeWithPrev, onGoToPrev, onGoToNext,
  focusedId, focusAtStart,
}) => {
  const contentRef     = useRef(null);
  const isComposingRef = useRef(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // 항목 id 변경 시 DOM 동기화
  useEffect(() => {
    if (contentRef.current && contentRef.current.innerHTML !== (item.content || '')) {
      contentRef.current.innerHTML = item.content || '';
    }
  }, [item.id]);

  // 포커스 이동 (외부 변경 시 DOM도 함께 업데이트)
  useEffect(() => {
    if (focusedId !== item.id || !contentRef.current) return;
    if (contentRef.current.innerHTML !== (item.content || '')) {
      contentRef.current.innerHTML = item.content || '';
    }
    contentRef.current.focus();
    try {
      const range = document.createRange();
      const sel   = window.getSelection();
      range.selectNodeContents(contentRef.current);
      range.collapse(focusAtStart); // true = 맨 앞, false = 맨 뒤
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* 빈 노드 무시 */ }
  }, [focusedId, item.id]);

  const handleKeyDown = (e) => {
    const nativeEvent = e.nativeEvent;
    const isComposing = isComposingRef.current || nativeEvent?.isComposing || nativeEvent?.keyCode === 229;

    // ── Enter: 커서 뒤 내용을 새 항목으로 분리 ──────────────────────────────
    if (e.key === 'Enter') {
      if (isComposing) return;
      e.preventDefault();

      let afterHTML = '';
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents(); // 선택 영역 삭제
        try {
          const afterRange = document.createRange();
          afterRange.selectNodeContents(contentRef.current);
          afterRange.setStart(range.endContainer, range.endOffset);
          const fragment = afterRange.extractContents();
          const tmp = document.createElement('div');
          tmp.appendChild(fragment);
          afterHTML = tmp.innerHTML === '<br>' ? '' : tmp.innerHTML;
        } catch { /* 빈 노드 무시 */ }
      }

      const currentHTML = contentRef.current.innerHTML;
      const cleanCurrent = (currentHTML === '<br>' || currentHTML === '') ? '' : currentHTML;
      onEnter(index, item.depth, item.bulletChar, item.listType, cleanCurrent, afterHTML);

    // ── Tab / Shift+Tab ──────────────────────────────────────────────────────
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.shiftKey ? onOutdent(item.id) : onIndent(item.id);

    // ── Space: 자동 불렛/번호 변환 ───────────────────────────────────────────
    } else if (e.key === ' ' && !isComposing) {
      const text = contentRef.current.innerText.trim();
      let matchedType = null;
      if (text === '-')         matchedType = 'bullet';
      else if (text === '1.')   matchedType = 'decimal-dot';
      else if (text === '1)')   matchedType = 'decimal-paren';
      else if (text === '[1]')  matchedType = 'decimal-bracket';
      if (matchedType) {
        e.preventDefault();
        contentRef.current.innerHTML = '';
        onAutoConvert(item.id, matchedType);
        return;
      }

    // ── Backspace ─────────────────────────────────────────────────────────────
    } else if (e.key === 'Backspace' && !isComposing) {
      const isEmpty = !contentRef.current.innerText.trim() &&
                      !contentRef.current.querySelector('img');

      if (isEmpty) {
        e.preventDefault();
        if (item.depth > 0) {
          onOutdent(item.id);
        } else if (item.bulletChar || item.listType) {
          onUpdate(item.id, { bulletChar: '', listType: null });
        } else {
          onDelete(item.id, index);
        }
      } else if (isCursorAtStart(contentRef.current)) {
        // 커서가 맨 앞이고 내용이 있으면 → 이전 줄과 병합
        e.preventDefault();
        onMergeWithPrev(item.id, contentRef.current.innerHTML);
      }

    // ── ArrowUp: 줄 경계에서 이전 항목으로 ──────────────────────────────────
    } else if (e.key === 'ArrowUp' && !isComposing) {
      if (isCursorAtStart(contentRef.current)) {
        e.preventDefault();
        onGoToPrev(index);
      }

    // ── ArrowDown: 줄 경계에서 다음 항목으로 ────────────────────────────────
    } else if (e.key === 'ArrowDown' && !isComposing) {
      if (isCursorAtEnd(contentRef.current)) {
        e.preventDefault();
        onGoToNext(index);
      }
    }
  };

  const label = item.listType ? formatListLabel(item.listType, listNumber ?? 1) : null;

  return (
    <div className="group flex items-start gap-1" style={{ marginLeft: `${item.depth * 28}px`, breakInside: 'avoid' }}>
      {/* 불렛 버튼 */}
      <div className="relative mt-1 flex-shrink-0">
        <button onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="h-7 min-w-[1.75rem] px-0.5 flex items-center justify-center rounded hover:bg-gray-100 text-gray-700">
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
            <p className="text-[10px] text-gray-400 mb-1.5">불렛 기호</p>
            {customBullets.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-3">
                {customBullets.map((char, i) => (
                  <button key={`${char}-${i}`}
                    onClick={() => { onBulletChange(item.id, item.depth, char, null); setIsMenuOpen(false); }}
                    className={`w-7 h-7 rounded text-base hover:bg-blue-50 transition-colors ${item.bulletChar === char && !item.listType ? 'bg-blue-100 ring-1 ring-blue-300' : ''}`}>
                    {char}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-gray-300 mb-3">기호 없음 — 설정에서 추가하세요</p>
            )}
            <div className="border-t border-gray-100 pt-2.5 mb-2">
              <p className="text-[10px] text-gray-400 mb-1.5">번호 목록</p>
              <div className="flex gap-1">
                {LIST_TYPES.map(({ type, preview }) => (
                  <button key={type}
                    onClick={() => { onBulletChange(item.id, item.depth, '', type); setIsMenuOpen(false); }}
                    className={`flex-1 py-1.5 text-xs rounded-lg font-mono border transition-all ${item.listType === type ? 'bg-black text-white border-black' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    {preview}
                  </button>
                ))}
              </div>
            </div>
            {(item.bulletChar || item.listType) && (
              <button onClick={() => { onUpdate(item.id, { bulletChar: '', listType: null }); setIsMenuOpen(false); }}
                className="w-full py-1 text-[10px] text-gray-400 hover:bg-gray-100 rounded-lg transition-colors">기호 제거</button>
            )}
            <div className="fixed inset-0 -z-10" onClick={() => setIsMenuOpen(false)} />
          </div>
        )}
      </div>

      {/* 본문 */}
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

      <button onClick={() => onDelete(item.id, index)}
        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1.5 text-gray-300 hover:text-red-400 transition-opacity">
        <Trash2 size={14} />
      </button>
    </div>
  );
};

// ── 사이드바 노트 아이템 ──────────────────────────────────────────────────────
const SidebarNoteItem = ({ note, isActive, onClick, indent = false }) => (
  <div onClick={onClick}
    className={`px-3 py-2 rounded-lg cursor-pointer mb-0.5 ${indent ? 'ml-4' : ''} ${isActive ? 'bg-gray-200' : 'hover:bg-gray-100'}`}>
    <div className={`text-sm truncate ${isActive ? 'font-bold text-gray-900' : 'text-gray-600'}`}>
      {note.title || '제목 없음'}
    </div>
    {note.updatedAt && (
      <div className="text-[10px] text-gray-400 mt-0.5">{formatDate(note.updatedAt)}</div>
    )}
  </div>
);

// ── 노트 생성 헬퍼 ────────────────────────────────────────────────────────────
const newBlankNote = (title = '제목 없는 노트') => ({
  id: Math.random().toString(36).substr(2, 9),
  title,
  columns: 1,
  items: [{ id: Math.random().toString(36).substr(2, 9), content: '', depth: 0, bulletChar: '•', listType: null }],
});

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode]               = useState('welcome');
  const [user, setUser]               = useState(null);
  const [authError, setAuthError]     = useState('');
  const [notes, setNotes]             = useState([]);
  const [folders, setFolders]         = useState([]);
  const [activeNoteId, setActiveNoteId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [focusedId, setFocusedId]     = useState(null);
  const [focusAtStart, setFocusAtStart] = useState(false);
  const [isSaving, setIsSaving]       = useState(false);
  const [isSettingsOpen, setIsSettingsOpen]             = useState(false);
  const [isBulletSettingsOpen, setIsBulletSettingsOpen] = useState(false);
  const [copied, setCopied]           = useState(false);
  const [expandedFolders, setExpandedFolders] = useState(new Set(['__none__']));
  const [isAddingFolder, setIsAddingFolder]   = useState(false);
  const [newFolderName, setNewFolderName]     = useState('');
  const newFolderInputRef = useRef(null);

  const setFocused = useCallback((id, atStart = false) => {
    setFocusAtStart(atStart);
    setFocusedId(id);
  }, []);

  // 불렛 기호
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
    if (!firebaseConfig) { alert('Firebase 설정이 없습니다.'); return; }
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

  // ── 노트 Firestore 동기화 ─────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'app' || !user) return;
    const ref = collection(db, 'artifacts', appId, 'users', user.uid, 'notes');
    return onSnapshot(
      ref,
      (snap) => {
        setAuthError('');
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(n => !n.isDeleted)
          .sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
        setNotes(data);
        if (!activeNoteId && data.length > 0) setActiveNoteId(data[0].id);
      },
      (err) => {
        console.error('Firestore 노트 읽기 오류:', err);
        if (err.code === 'permission-denied') {
          setAuthError('⚠️ Firestore 보안 규칙이 설정되지 않았습니다. Firebase Console → Firestore → 규칙에서 읽기/쓰기를 허용해주세요.');
        } else {
          setAuthError(`데이터베이스 오류: ${err.message}`);
        }
      }
    );
  }, [mode, user]);

  // ── 폴더 Firestore 동기화 ─────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'app' || !user) return;
    const ref = collection(db, 'artifacts', appId, 'users', user.uid, 'folders');
    return onSnapshot(
      ref,
      (snap) => {
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(f => !f.isDeleted)
          .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
        setFolders(data);
      },
      (err) => { console.error('Firestore 폴더 읽기 오류:', err); }
    );
  }, [mode, user]);

  const activeNote = notes.find(n => n.id === activeNoteId);

  // ── Firestore 자동 저장 ───────────────────────────────────────────────────
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
  const createNote = async (folderId = null) => {
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
      { ...note, folderId: folderId || null, isDeleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    );
    setActiveNoteId(note.id);
  };

  // ── 폴더 CRUD ─────────────────────────────────────────────────────────────
  const createFolder = async (name) => {
    if (mode !== 'app' || !user || !name.trim()) return;
    const id = Math.random().toString(36).substr(2, 9);
    await setDoc(
      doc(db, 'artifacts', appId, 'users', user.uid, 'folders', id),
      { id, name: name.trim(), isDeleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    );
    setExpandedFolders(prev => new Set([...prev, id]));
  };

  const deleteFolder = async (folderId) => {
    if (mode !== 'app' || !user) return;
    await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'folders', folderId), { isDeleted: true }, { merge: true });
    notes.filter(n => n.folderId === folderId).forEach(n => {
      setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'notes', n.id), { folderId: null }, { merge: true });
    });
  };

  const moveNoteToFolder = async (noteId, folderId) => {
    if (mode !== 'app' || !user) return;
    await setDoc(
      doc(db, 'artifacts', appId, 'users', user.uid, 'notes', noteId),
      { folderId: folderId || null, updatedAt: serverTimestamp() },
      { merge: true }
    );
  };

  const toggleFolder = (folderId) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.has(folderId) ? next.delete(folderId) : next.add(folderId);
      return next;
    });
  };

  // ── 항목 업데이트 ─────────────────────────────────────────────────────────
  const updateNote  = (u) => setNotes(prev => prev.map(n => n.id === activeNoteId ? { ...n, ...u } : n));
  const updateItems = (items) => setNotes(prev => prev.map(n => n.id === activeNoteId ? { ...n, items } : n));

  // ── 항목 추가 (Enter: 현재 내용 + 이후 내용 동시 처리) ───────────────────
  const addItem = (i, d, c, lt, currentContent, afterContent = '') => {
    const id = Math.random().toString(36).substr(2, 9);
    const next = [...activeNote.items];
    next[i] = { ...next[i], content: currentContent };
    next.splice(i + 1, 0, { id, content: afterContent, depth: d, bulletChar: c || '', listType: lt || null });
    updateItems(next);
    setFocused(id, true);
  };

  // ── 항목 삭제 ─────────────────────────────────────────────────────────────
  const deleteItem = (id, i) => {
    if (activeNote.items.length <= 1) return;
    updateItems(activeNote.items.filter(it => it.id !== id));
    if (i > 0) setFocused(activeNote.items[i - 1].id, false);
  };

  // ── 이전 항목과 병합 (Backspace at start) ────────────────────────────────
  const mergeItemWithPrev = (id, appendHTML) => {
    const idx = activeNote.items.findIndex(it => it.id === id);
    if (idx <= 0) return;
    const prevItem = activeNote.items[idx - 1];
    const clean = (!appendHTML || appendHTML === '<br>') ? '' : appendHTML;
    const merged = prevItem.content + clean;

    setNotes(prev => prev.map(n => {
      if (n.id !== activeNoteId) return n;
      const newItems = n.items
        .map((it, k) => k === idx - 1 ? { ...it, content: merged } : it)
        .filter((_, k) => k !== idx);
      return { ...n, items: newItems };
    }));
    setFocused(prevItem.id, false);
  };

  // ── 방향키 항목 이동 ──────────────────────────────────────────────────────
  const goToPrevItem = (index) => {
    if (!activeNote || index <= 0) return;
    setFocused(activeNote.items[index - 1].id, false);
  };
  const goToNextItem = (index) => {
    if (!activeNote || index >= activeNote.items.length - 1) return;
    setFocused(activeNote.items[index + 1].id, true);
  };

  // ── 불렛 변경 ─────────────────────────────────────────────────────────────
  const handleBulletChange = (id, depth, bulletChar, listType) => {
    const idx   = activeNote.items.findIndex(it => it.id === id);
    const group = getBulletGroup(activeNote.items, idx);
    updateItems(activeNote.items.map((it, i) => {
      const isTarget  = it.id === id;
      const inGroup   = group.has(i);
      const sameDepth = it.depth === depth;
      if (listType) {
        if (isTarget || (inGroup && sameDepth && it.listType)) return { ...it, bulletChar: '', listType };
      } else if (bulletChar) {
        if (isTarget || (inGroup && sameDepth && it.bulletChar)) return { ...it, bulletChar, listType: null };
      }
      return it;
    }));
  };

  // ── 자동 변환 ─────────────────────────────────────────────────────────────
  const handleAutoConvert = (id, matchedType) => {
    if (matchedType === 'bullet') {
      const firstBullet = customBullets[0] || '•';
      updateItems(activeNote.items.map(it => it.id === id ? { ...it, bulletChar: firstBullet, listType: null } : it));
    } else {
      updateItems(activeNote.items.map(it => it.id === id ? { ...it, bulletChar: '', listType: matchedType } : it));
    }
  };

  // ── 마크다운 복사 ─────────────────────────────────────────────────────────
  const copyAsMarkdown = async () => {
    if (!activeNote) return;
    const lines = [`# ${activeNote.title}`, ''];
    activeNote.items.forEach((item, i) => {
      const indent = '  '.repeat(item.depth);
      const text   = stripHtml(item.content);
      const num    = getListNumber(activeNote.items, i);
      let prefix   = '';
      if (item.listType)        prefix = formatListLabel(item.listType, num ?? 1) + ' ';
      else if (item.bulletChar) prefix = '- ';
      lines.push(indent + prefix + text);
    });
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── 폴더별 노트 그룹 ─────────────────────────────────────────────────────
  const notesByFolder = {};
  notes.forEach(n => {
    const fid = n.folderId || '__none__';
    if (!notesByFolder[fid]) notesByFolder[fid] = [];
    notesByFolder[fid].push(n);
  });
  const unfiledNotes = notesByFolder['__none__'] || [];

  // 새 폴더 입력창 오토포커스
  useEffect(() => {
    if (isAddingFolder) newFolderInputRef.current?.focus();
  }, [isAddingFolder]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) { setIsAddingFolder(false); return; }
    await createFolder(newFolderName);
    setNewFolderName('');
    setIsAddingFolder(false);
  };

  // ── 렌더 분기 ─────────────────────────────────────────────────────────────
  if (mode === 'welcome') return <WelcomeScreen onGuest={enterGuest} onGoogleSync={enterGoogleSync} />;
  if (mode === 'app' && !user) return (
    <div className="h-screen flex items-center justify-center text-gray-400 text-sm">인증 중...</div>
  );
  if (!activeNote) return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 text-gray-400">
      <p className="text-sm">노트가 없습니다.</p>
      <button onClick={() => createNote()} className="px-4 py-2 bg-black text-white rounded-lg text-sm hover:bg-gray-800">새 노트 만들기</button>
    </div>
  );

  const columns = activeNote.columns ?? 1;

  return (
    <div className="flex h-screen bg-white font-sans overflow-hidden">

      {/* ── 사이드바 ──────────────────────────────────────────────────────── */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} bg-[#fbfbfa] border-r transition-all duration-300 flex flex-col overflow-hidden flex-shrink-0`}>

        <div className="p-4 font-bold tracking-tighter text-xl border-b flex items-center gap-2 flex-shrink-0">
          <div className="w-6 h-6 bg-black text-white flex items-center justify-center rounded text-xs">b</div>
          bnote
          {mode === 'guest' && (
            <span className="ml-auto text-[10px] font-normal bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">체험판</span>
          )}
        </div>

        {/* 노트 목록 */}
        <div className="flex-1 overflow-y-auto p-2">
          {mode === 'app' && folders.length > 0 ? (
            <>
              {/* 폴더 그룹 */}
              {folders.map(folder => (
                <div key={folder.id} className="mb-1">
                  <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-gray-100 group"
                    onClick={() => toggleFolder(folder.id)}>
                    {expandedFolders.has(folder.id)
                      ? <ChevronDown size={11} className="text-gray-400 flex-shrink-0" />
                      : <ChevronRight size={11} className="text-gray-400 flex-shrink-0" />}
                    <Folder size={11} className="text-gray-400 flex-shrink-0" />
                    <span className="text-xs text-gray-500 font-medium truncate flex-1">{folder.name}</span>
                    <button
                      onClick={e => { e.stopPropagation(); if (window.confirm(`"${folder.name}" 폴더를 삭제할까요?`)) deleteFolder(folder.id); }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-300 hover:text-red-400 transition-opacity text-sm leading-none">×</button>
                  </div>
                  {expandedFolders.has(folder.id) && (notesByFolder[folder.id] || []).map(n => (
                    <SidebarNoteItem key={n.id} note={n} isActive={activeNoteId === n.id}
                      onClick={() => setActiveNoteId(n.id)} indent />
                  ))}
                </div>
              ))}

              {/* 폴더 없는 노트 */}
              {unfiledNotes.length > 0 && (
                <div className="mb-1">
                  <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-gray-100"
                    onClick={() => toggleFolder('__none__')}>
                    {expandedFolders.has('__none__')
                      ? <ChevronDown size={11} className="text-gray-400" />
                      : <ChevronRight size={11} className="text-gray-400" />}
                    <span className="text-xs text-gray-400 font-medium">기타</span>
                  </div>
                  {expandedFolders.has('__none__') && unfiledNotes.map(n => (
                    <SidebarNoteItem key={n.id} note={n} isActive={activeNoteId === n.id}
                      onClick={() => setActiveNoteId(n.id)} indent />
                  ))}
                </div>
              )}
            </>
          ) : (
            /* 폴더 없음 or 게스트: 일반 목록 */
            notes.map(n => (
              <SidebarNoteItem key={n.id} note={n} isActive={activeNoteId === n.id}
                onClick={() => setActiveNoteId(n.id)} />
            ))
          )}
        </div>

        {/* 하단 버튼 */}
        <div className="p-3 border-t flex-shrink-0 space-y-1">
          <button onClick={() => createNote()} className="w-full flex items-center justify-center gap-1 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">
            <Plus size={14} /> 새 노트
          </button>

          {mode === 'app' && (
            isAddingFolder ? (
              <div className="flex gap-1">
                <input ref={newFolderInputRef} value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => {
                    // 한글 IME 조합 중 Enter는 무시 (두 번 생성 방지)
                    const isComposing = e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229;
                    if (e.key === 'Enter' && !isComposing) handleCreateFolder();
                    if (e.key === 'Escape') { setIsAddingFolder(false); setNewFolderName(''); }
                  }}
                  placeholder="폴더 이름"
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-gray-400" />
                <button onClick={handleCreateFolder} className="px-2 py-1 text-xs bg-black text-white rounded-lg hover:bg-gray-800">추가</button>
              </div>
            ) : (
              <button onClick={() => setIsAddingFolder(true)}
                className="w-full flex items-center justify-center gap-1 py-1.5 text-xs text-gray-400 hover:bg-gray-100 rounded-lg">
                <Folder size={12} /> 새 폴더
              </button>
            )
          )}
        </div>

        <div className="px-4 pb-3 text-[10px] text-gray-400 flex justify-between items-center flex-shrink-0">
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

        <header className="h-12 border-b flex items-center px-4 gap-1 flex-shrink-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 hover:bg-gray-100 rounded">
            <Menu size={18} />
          </button>
          <div className="h-4 w-px bg-gray-200 mx-1" />
          <button onMouseDown={e => { e.preventDefault(); document.execCommand('bold'); }} className="p-1.5 hover:bg-gray-100 rounded">
            <Bold size={16} />
          </button>
          <button onMouseDown={e => { e.preventDefault(); document.execCommand('underline'); }} className="p-1.5 hover:bg-gray-100 rounded">
            <Underline size={16} />
          </button>
          <div className="h-4 w-px bg-gray-200 mx-1" />
          <button onClick={copyAsMarkdown} title="마크다운으로 전체 복사"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-all ${copied ? 'bg-green-50 text-green-600' : 'hover:bg-gray-100 text-gray-500'}`}>
            {copied ? <><Check size={13} /> 복사됨</> : <><Copy size={13} /> MD 복사</>}
          </button>

          <div className="relative ml-auto">
            <button onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className={`p-1.5 rounded transition-colors ${isSettingsOpen ? 'bg-gray-100' : 'hover:bg-gray-100'}`}>
              <Settings size={16} className="text-gray-500" />
            </button>

            {isSettingsOpen && (
              <div className="absolute right-0 top-9 z-40 bg-white border border-gray-100 shadow-2xl rounded-xl p-4 w-56">
                <p className="text-[10px] text-gray-400 font-medium mb-3">페이지 설정</p>

                <div className="mb-4">
                  <p className="text-xs text-gray-500 mb-2">레이아웃</p>
                  <div className="flex gap-1.5">
                    {[1, 2].map(col => (
                      <button key={col} onClick={() => { updateNote({ columns: col }); setIsSettingsOpen(false); }}
                        className={`flex-1 py-2 text-xs rounded-lg border transition-all ${columns === col ? 'bg-black text-white border-black' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                        {col}단
                      </button>
                    ))}
                  </div>
                </div>

                {/* 폴더 이동 */}
                {mode === 'app' && (
                  <div className="mb-4 border-t pt-3">
                    <p className="text-xs text-gray-500 mb-2">폴더</p>
                    {folders.length === 0 ? (
                      <p className="text-[10px] text-gray-400">폴더가 없습니다.<br />사이드바에서 새 폴더를 만드세요.</p>
                    ) : (
                      <select
                        value={activeNote?.folderId || ''}
                        onChange={e => { moveNoteToFolder(activeNoteId, e.target.value || null); setIsSettingsOpen(false); }}
                        className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-gray-400 bg-white">
                        <option value="">폴더 없음</option>
                        {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    )}
                  </div>
                )}

                <div className="border-t pt-3">
                  <button onClick={() => { setIsSettingsOpen(false); setIsBulletSettingsOpen(true); }}
                    className="w-full py-2 text-xs text-gray-500 hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors">
                    불렛 기호 목록 관리 →
                  </button>
                </div>
                <div className="fixed inset-0 -z-10" onClick={() => setIsSettingsOpen(false)} />
              </div>
            )}
          </div>

          {mode === 'guest' && (
            <div className="flex items-center gap-2 text-xs text-amber-500 ml-2">
              <AlertCircle size={13} />
              <span className="hidden sm:inline">체험판 · 새로고침 시 초기화</span>
              <button onClick={enterGoogleSync} className="ml-1 px-2.5 py-1 bg-black text-white rounded-md text-[11px] hover:bg-gray-800">구글 로그인</button>
            </div>
          )}
        </header>

        <div className={`flex-1 overflow-y-auto pt-20 pb-64 ${columns === 2 ? 'px-6 sm:px-10 md:px-16' : 'px-6 sm:px-12 md:px-24 lg:px-48 xl:px-64'}`}>
          <input
            className="w-full text-4xl font-bold mb-12 outline-none bg-transparent"
            value={activeNote.title}
            onChange={e => setNotes(notes.map(n => n.id === activeNoteId ? { ...n, title: e.target.value } : n))}
          />

          <div className="space-y-0.5" style={{ ...(columns === 2 ? { columnCount: 2, columnGap: '2.5rem' } : {}), userSelect: 'text' }}>
            {activeNote.items.map((item, i) => (
              <NoteItem
                key={item.id}
                item={item}
                index={i}
                listNumber={getListNumber(activeNote.items, i)}
                customBullets={customBullets}
                onUpdate={(id, up) => updateItems(activeNote.items.map(it => it.id === id ? { ...it, ...up } : it))}
                onDelete={deleteItem}
                onEnter={addItem}
                onIndent={id => updateItems(activeNote.items.map(it => it.id === id ? { ...it, depth: Math.min(5, it.depth + 1) } : it))}
                onOutdent={id => updateItems(activeNote.items.map(it => it.id === id ? { ...it, depth: Math.max(0, it.depth - 1) } : it))}
                onBulletChange={handleBulletChange}
                onAutoConvert={handleAutoConvert}
                onMergeWithPrev={mergeItemWithPrev}
                onGoToPrev={goToPrevItem}
                onGoToNext={goToNextItem}
                focusedId={focusedId}
                focusAtStart={focusAtStart}
              />
            ))}
          </div>
        </div>
      </main>

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
