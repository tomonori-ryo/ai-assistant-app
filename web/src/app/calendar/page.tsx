"use client";
import { useEffect, useState, useMemo } from 'react';
import { addDays, format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameMonth, isSameDay, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale/ja';
import { getEvents, subscribeToEvents, type FirestoreEvent, deleteEvent, updateEvent, getUserSettings, getNotificationSettings, addEvent, updateUserSettings } from "../../lib/firestore";
import { scheduleEventNotification, cancelScheduledNotification } from "../../lib/notifications";
import { getEventColor, getCategoryLabel } from "../../lib/colors";

// 日本の祝日リスト（2025年）
const JAPANESE_HOLIDAYS_2025 = [
  '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
  '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23',
  '2025-10-13', '2025-11-03', '2025-11-23', '2025-11-24'
];

// 時間を読みやすくフォーマットする関数
function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '時間未設定';
  
  try {
    // データ形式を判別
    const hasMilliseconds = start.includes('.'); // 新しいデータは `.000Z` のようにミリ秒付き
    const hasTimezone = start.endsWith('Z') || start.includes('+');
    const hasJSTOffset = start.includes('+09:00'); // JSTオフセット付きか
    
    let startDate: Date;
    if (hasJSTOffset) {
      // JSTオフセット付き（+09:00）：正しい形式なのでそのまま使用
      startDate = parseISO(start);
    } else if (hasTimezone && !hasMilliseconds) {
      // 古いデータ（ミリ秒なし+UTC接尾辞）：誤ってJST時刻にZが付いているため補正が必要
      // 例: "2025-11-08T19:00:00Z" → JST 19:00のつもり
      const startParsed = parseISO(start);
      const adjustMillis = startParsed.getTimezoneOffset() * 60 * 1000;
      startDate = new Date(startParsed.getTime() + adjustMillis);
    } else if (hasTimezone && hasMilliseconds) {
      // 新しいデータ（ミリ秒付き+UTC接尾辞）：正しくUTC時刻で保存されている
      // 例: "2025-11-08T10:00:00.000Z" → UTC 10:00 = JST 19:00
      startDate = parseISO(start);
    } else {
      // タイムゾーン情報がないデータ：ローカル時刻として解釈
      startDate = parseISO(start);
    }
    const startTime = format(startDate, 'HH:mm');
    
    // デバッグログ（時刻のズレを確認するため）
    if (start.includes('T19:00') || start.includes('T00:00') || start.includes('T10:00')) {
      console.log('[Calendar] ⚠️ Time debugging:', {
        stored_in_db: start,
        has_milliseconds: hasMilliseconds,
        has_timezone: hasTimezone,
        correction_applied: hasTimezone && !hasMilliseconds,
        displayed_time: startTime,
        local_display: startDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      });
    }
    
    if (!end) return startTime;
    
    // 終了時刻も同様に処理
    const endHasMilliseconds = end.includes('.');
    const endHasTimezone = end.endsWith('Z') || end.includes('+');
    const endHasJSTOffset = end.includes('+09:00');
    
    let endDate: Date;
    if (endHasJSTOffset) {
      // JSTオフセット付き：そのまま使用
      endDate = parseISO(end);
    } else if (endHasTimezone && !endHasMilliseconds) {
      // 古いデータの補正
      const endParsed = parseISO(end);
      const adjustMillis = endParsed.getTimezoneOffset() * 60 * 1000;
      endDate = new Date(endParsed.getTime() + adjustMillis);
    } else {
      endDate = parseISO(end);
    }
    const endTime = format(endDate, 'HH:mm');
    
    // 日付が異なる場合（翌日）
    const startDay = format(startDate, 'yyyy-MM-dd');
    const endDay = format(endDate, 'yyyy-MM-dd');
    
    if (startDay !== endDay) {
      return `${startTime} - ${endTime} (翌日)`;
    }
    
    return `${startTime} - ${endTime}`;
  } catch {
    return `${start} - ${end ?? ''}`;
  }
}

export default function CalendarPage() {
  const [events, setEvents] = useState<FirestoreEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [schoolTimings, setSchoolTimings] = useState<any[]>([]); // 学校の授業時間
  const [schoolProfile, setSchoolProfile] = useState<any>(null); // 学校プロファイル
  const [editingSchoolEvent, setEditingSchoolEvent] = useState<{eventId: string, classes: any[]} | null>(null); // 学校イベント編集中
  
  // 通知管理
  const [notificationTimeouts, setNotificationTimeouts] = useState<Record<string, number>>({});
  
  // 編集モーダル用ステート
  const [editingEvent, setEditingEvent] = useState<FirestoreEvent | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    date: '', // 日付（YYYY-MM-DD形式）
    start_time: '', // 時刻（HH:mm形式）
    end_time: '', // 時刻（HH:mm形式）
    location: '',
    locationInfo: null as { name: string; address?: string; lat?: number; lng?: number; place_id?: string; confirmed?: boolean } | null,
    attendees: '',
    meeting_link: '',
    agenda: '',
    custom_color: ''
  });
  const [showEditDatePicker, setShowEditDatePicker] = useState(false); // 編集時の日付変更モード
  
  // 新規追加モーダル用ステート
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEventForm, setNewEventForm] = useState({
    title: '',
    date: '', // 日付（YYYY-MM-DD形式）
    start_time: '', // 時刻（HH:mm形式）
    end_time: '', // 時刻（HH:mm形式）
    category: 'other' as 'work_study' | 'life_chores' | 'leisure' | 'other',
    location: '',
    locationInfo: null as { name: string; address?: string; lat?: number; lng?: number; place_id?: string; confirmed?: boolean } | null,
    attendees: '',
    meeting_link: '',
    agenda: '',
    custom_color: ''
  });
  const [showDatePicker, setShowDatePicker] = useState(false); // 日付変更モード
  
  // 場所検索用ステート
  const [showLocationSearch, setShowLocationSearch] = useState(false);
  const [locationSearchQuery, setLocationSearchQuery] = useState('');
  const [locationCandidates, setLocationCandidates] = useState<Array<{ name: string; address?: string; lat?: number; lng?: number; place_id?: string }>>([]);
  const [searchingLocation, setSearchingLocation] = useState(false);
  const [locationSearchFor, setLocationSearchFor] = useState<'new' | 'edit'>('new');

  const loadEvents = async () => {
    setLoading(true);
    setError(null);
    try {
      console.log('[Calendar] Loading events from Firestore...');
      const list = await getEvents();
      console.log('[Calendar] Loaded', list.length, 'events');
      
      // UTC形式（.000Z付き）のイベントを自動的にJST形式に変換
      let convertedCount = 0;
      for (const event of list) {
        if (event.id && event.start_time && event.start_time.includes('.000Z')) {
          console.log('[Calendar] 🔄 UTC形式のイベントを発見:', event.title);
          
          try {
            // UTC時刻をJST形式に変換
            const startDate = new Date(event.start_time);
            const endDate = event.end_time ? new Date(event.end_time) : null;
            
            // JSTのオフセット付き形式に変換
            const formatJST = (date: Date) => {
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              const hours = String(date.getHours()).padStart(2, '0');
              const minutes = String(date.getMinutes()).padStart(2, '0');
              return `${year}-${month}-${day}T${hours}:${minutes}:00+09:00`;
            };
            
            const updates: Partial<FirestoreEvent> = {
              start_time: formatJST(startDate),
              end_time: endDate ? formatJST(endDate) : undefined
            };
            
            console.log('[Calendar]   変換前:', event.start_time, '→', event.end_time);
            console.log('[Calendar]   変換後:', updates.start_time, '→', updates.end_time);
            
            await updateEvent(event.id, updates);
            convertedCount++;
          } catch (err) {
            console.error('[Calendar] ⚠️ 変換失敗:', event.title, err);
          }
        }
      }
      
      if (convertedCount > 0) {
        console.log(`[Calendar] ✅ ${convertedCount}件のイベントをJST形式に変換しました`);
        // 再読み込み
        const updatedList = await getEvents();
        setEvents(updatedList);
        await scheduleNotificationsForEvents(updatedList);
      } else {
        setEvents(list);
        await scheduleNotificationsForEvents(list);
      }
      
      // 学校プロファイルから授業時間を読み込む
      try {
        const settings = await getUserSettings();
        const school = settings.school_profiles?.[0];
        if (school) {
          setSchoolProfile(school);
          if (school.timings) {
            setSchoolTimings(school.timings);
            console.log('[Calendar] Loaded school timings:', school.timings.length);
          }
        }
      } catch (err) {
        console.error('[Calendar] Failed to load school profile:', err);
      }
    } catch (e: any) {
      console.error('[Calendar] Load error:', e);
      setError(e?.message ?? '予定の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  };
  
  // イベントに対する通知をスケジュール
  const scheduleNotificationsForEvents = async (eventList: FirestoreEvent[]) => {
    try {
      const settings = await getNotificationSettings();
      
      // 既存の通知をキャンセル
      Object.values(notificationTimeouts).forEach(timeoutId => {
        cancelScheduledNotification(timeoutId);
      });
      
      const newTimeouts: Record<string, number> = {};
      
      // 未来のイベントに対して通知をスケジュール
      for (const event of eventList) {
        if (event.start_time && event.id) {
          const startTime = new Date(event.start_time);
          const now = new Date();
          
          // 開始時刻が未来の場合のみスケジュール
          if (startTime > now) {
            const timeoutId = scheduleEventNotification(
              event.title,
              startTime,
              settings.notifyBeforeEvent,
              event.category, // カテゴリーを渡す
              settings        // 設定を渡す
            );
            
            if (timeoutId) {
              newTimeouts[event.id] = timeoutId;
            }
          }
        }
      }
      
      setNotificationTimeouts(newTimeouts);
    } catch (error) {
      console.error('[Notification] イベント通知のスケジュールに失敗:', error);
    }
  };

  // 場所検索を開始
  const startLocationSearch = (forType: 'new' | 'edit') => {
    setLocationSearchFor(forType);
    setLocationSearchQuery('');
    setLocationCandidates([]);
    setShowLocationSearch(true);
  };
  
  // 場所を検索
  const searchLocation = async () => {
    if (!locationSearchQuery.trim()) {
      alert('検索キーワードを入力してください');
      return;
    }
    
    setSearchingLocation(true);
    try {
      const response = await fetch('/api/location/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: locationSearchQuery })
      });
      
      const data = await response.json();
      
      if (!data.success) {
        alert(data.error || '場所の検索に失敗しました');
        return;
      }
      
      setLocationCandidates(data.candidates || []);
    } catch (error) {
      console.error('[Calendar] Location search error:', error);
      alert('場所の検索に失敗しました');
    } finally {
      setSearchingLocation(false);
    }
  };
  
  // 場所を選択
  const selectLocation = (candidate: { name: string; address?: string; lat?: number; lng?: number; place_id?: string }) => {
    if (locationSearchFor === 'new') {
      setNewEventForm({
        ...newEventForm,
        location: candidate.name,
        locationInfo: {
          name: candidate.name,
          address: candidate.address,
          lat: candidate.lat,
          lng: candidate.lng,
          place_id: candidate.place_id,
          confirmed: true
        }
      });
    } else {
      setEditForm({
        ...editForm,
        location: candidate.name,
        locationInfo: {
          name: candidate.name,
          address: candidate.address,
          lat: candidate.lat,
          lng: candidate.lng,
          place_id: candidate.place_id,
          confirmed: true
        }
      });
    }
    setShowLocationSearch(false);
    setLocationCandidates([]);
    setLocationSearchQuery('');
  };
  
  // 編集モーダルを開く
  const openEditModal = (event: FirestoreEvent) => {
    setEditingEvent(event);
    
    // JST形式の時刻を日付と時刻に分離
    const splitDateTime = (isoString: string) => {
      if (!isoString) return { date: '', time: '' };
      // "2025-11-13T19:00:00+09:00" → date: "2025-11-13", time: "19:00"
      const parts = isoString.split('T');
      if (parts.length !== 2) return { date: '', time: '' };
      const date = parts[0];
      const time = parts[1].slice(0, 5); // "19:00:00+09:00" → "19:00"
      return { date, time };
    };
    
    const startDateTime = splitDateTime(event.start_time || '');
    const endDateTime = splitDateTime(event.end_time || '');
    
    // フォームに既存の値をセット
    setEditForm({
      title: event.title || '',
      date: startDateTime.date,
      start_time: startDateTime.time,
      end_time: endDateTime.time,
      location: event.location || '',
      locationInfo: event.location_info || null,
      attendees: event.attendees?.join(', ') || '',
      meeting_link: event.meeting_link || '',
      agenda: event.agenda?.join('\n') || '',
      custom_color: event.custom_color || ''
    });
    setShowEditDatePicker(false); // 日付変更モードをリセット
  };
  
  // 編集モーダルを閉じる
  const closeEditModal = () => {
    setEditingEvent(null);
    setShowEditDatePicker(false);
    setEditForm({
      title: '',
      date: '',
      start_time: '',
      end_time: '',
      location: '',
      locationInfo: null,
      attendees: '',
      meeting_link: '',
      agenda: '',
      custom_color: ''
    });
  };
  
  // 編集を保存
  const saveEdit = async () => {
    if (!editingEvent) return;
    
    try {
      // 日付と時刻を組み合わせてJST形式に変換
      const formatAsJST = (date: string, time: string) => {
        if (!date || !time) return '';
        // "2025-11-13" + "19:00" → "2025-11-13T19:00:00+09:00"
        return `${date}T${time}:00+09:00`;
      };
      
      const updates: Partial<FirestoreEvent> = {
        title: editForm.title,
        start_time: formatAsJST(editForm.date, editForm.start_time),
        end_time: formatAsJST(editForm.date, editForm.end_time || editForm.start_time),
        location: editForm.location || null,
        location_info: editForm.locationInfo || null,
        attendees: editForm.attendees ? editForm.attendees.split(',').map(s => s.trim()).filter(Boolean) : null,
        meeting_link: editForm.meeting_link || null,
        agenda: editForm.agenda ? editForm.agenda.split('\n').filter(Boolean) : null,
        custom_color: editForm.custom_color || null
      };
      
      console.log('[Calendar] 予定を更新:', updates);
      
      if (!editingEvent.id) {
        throw new Error('Event ID is required');
      }
      
      await updateEvent(editingEvent.id, updates);
      await loadEvents(); // リロード
      closeEditModal();
    } catch (e: any) {
      console.error('[Calendar] Update error:', e);
      alert('予定の更新に失敗しました: ' + e.message);
    }
  };
  
  // 新規予定追加モーダルを開く
  const openAddModal = (date?: Date) => {
    // dateが指定されている場合は、その日付を使用（カレンダーから開く場合）
    // dateが指定されていない場合は、日付入力欄を表示（右上のボタンから開く場合）
    const hasSpecificDate = date !== undefined;
    const targetDate = date || selectedDate;
    const dateStr = format(targetDate, 'yyyy-MM-dd');
    
    setNewEventForm({
      title: '',
      date: dateStr, // 選択された日付
      start_time: '09:00', // 時刻のみ
      end_time: '10:00', // 時刻のみ
      category: 'other',
      location: '',
      locationInfo: null,
      attendees: '',
      meeting_link: '',
      agenda: '',
      custom_color: ''
    });
    // 右上のボタンから開く場合（date未指定）は日付入力欄を表示
    setShowDatePicker(!hasSpecificDate);
    setShowAddModal(true);
  };
  
  // 新規予定追加モーダルを閉じる
  const closeAddModal = () => {
    setShowAddModal(false);
    setShowDatePicker(false);
    setNewEventForm({
      title: '',
      date: '',
      start_time: '',
      end_time: '',
      category: 'other',
      location: '',
      locationInfo: null,
      attendees: '',
      meeting_link: '',
      agenda: '',
      custom_color: ''
    });
  };
  
  // 新規予定を追加
  const saveNewEvent = async () => {
    if (!newEventForm.title.trim()) {
      alert('タイトルを入力してください');
      return;
    }
    
    if (!newEventForm.date || !newEventForm.start_time) {
      alert('日付と開始時刻を入力してください');
      return;
    }
    
    try {
      // 日付と時刻を組み合わせてJST形式に変換
      const formatAsJST = (date: string, time: string) => {
        if (!date || !time) return '';
        // "2025-11-13" + "19:00" → "2025-11-13T19:00:00+09:00"
        return `${date}T${time}:00+09:00`;
      };
      
      const newEvent: FirestoreEvent = {
        title: newEventForm.title,
        start_time: formatAsJST(newEventForm.date, newEventForm.start_time),
        end_time: formatAsJST(newEventForm.date, newEventForm.end_time || newEventForm.start_time),
        category: newEventForm.category,
        location: newEventForm.location || null,
        location_info: newEventForm.locationInfo || null,
        attendees: newEventForm.attendees ? newEventForm.attendees.split(',').map(s => s.trim()).filter(Boolean) : null,
        meeting_link: newEventForm.meeting_link || null,
        agenda: newEventForm.agenda ? newEventForm.agenda.split('\n').filter(Boolean) : null,
        custom_color: newEventForm.custom_color || null,
        source: 'aimo_manual' // AIMOで手動追加された予定
      };
      
      console.log('[Calendar] 新規予定を追加:', newEvent);
      
      await addEvent(newEvent);
      await loadEvents(); // リロード
      closeAddModal();
      alert('✓ 予定を追加しました');
    } catch (e: any) {
      console.error('[Calendar] Add event error:', e);
      alert('予定の追加に失敗しました: ' + e.message);
    }
  };

  useEffect(() => {
    // 初期読み込み（UTC変換処理を含む）
    loadEvents();
    
    // リアルタイム更新を購読
    const unsubscribe = subscribeToEvents(async (list) => {
      console.log('[Calendar] Events updated via real-time subscription:', list.length);
      
      // 通知の再スケジュール
      await scheduleNotificationsForEvents(list);
      
      // イベントを更新（UTC変換は既に完了している前提）
      setEvents(list);
    });
    
    // クリーンアップ
    return () => {
      unsubscribe();
    };
  }, []);

  const monthStart = startOfMonth(activeDate);
  const monthEnd = endOfMonth(activeDate);

  // カレンダーグリッドの日付
  const calendarDays = useMemo(() => {
    const start = startOfWeek(monthStart, { weekStartsOn: 0 });
    const end = endOfWeek(monthEnd, { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [monthStart, monthEnd]);

  const dateKey = (d: Date) => format(d, 'yyyy-MM-dd');

  // 日付ごとのイベントマップ
  const eventMap = useMemo(() => {
    const m = new Map<string, FirestoreEvent[]>();
    for (const ev of events) {
      const k = (ev.start_time || '').slice(0, 10);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(ev);
    }
    // 各日付のイベントを時間順にソート - Dateオブジェクトで比較
    for (const [key, eventsOnDay] of m.entries()) {
      m.set(key, eventsOnDay.sort((a, b) => {
        const timeA = a.start_time || '';
        const timeB = b.start_time || '';
        
        if (!timeA || !timeB) return 0;
        
        const dateA = new Date(timeA);
        const dateB = new Date(timeB);
        
        return dateA.getTime() - dateB.getTime();
      }));
    }
    return m;
  }, [events]);

  // 選択日のイベント（時刻順にソート）
  const selectedEvents = useMemo(() => {
    const key = dateKey(selectedDate);
    const eventsOnDay = eventMap.get(key) ?? [];
    
    console.log('[Calendar] 🔍 選択日:', key);
    console.log('[Calendar] 🔍 eventMapのキー:', Array.from(eventMap.keys()));
    console.log('[Calendar] 🔍 この日のイベント数:', eventsOnDay.length);
    
    // 開始時刻順にソート（早い時刻が上）- Dateオブジェクトで比較
    const sorted = [...eventsOnDay].sort((a, b) => {
      const timeA = a.start_time || '';
      const timeB = b.start_time || '';
      
      if (!timeA || !timeB) return 0;
      
      // Dateオブジェクトに変換して比較（タイムゾーンを考慮）
      const dateA = new Date(timeA);
      const dateB = new Date(timeB);
      
      return dateA.getTime() - dateB.getTime();
    });
    
    // デバッグログ - selectedEventsの順序確認
    console.log('[Calendar] ========== selectedEvents (ソート後) ==========');
    sorted.forEach((event, index) => {
      const date = new Date(event.start_time || '');
      const jstTime = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      console.log(`${index + 1}. ${event.title}`);
      console.log(`   DB時刻: ${event.start_time}`);
      console.log(`   JST表示: ${jstTime} (${date.getTime()})`);
      console.log(`   source: ${event.source}`);
    });
    console.log('[Calendar] ================================================');
    
    return sorted;
  }, [selectedDate, eventMap]);
  
  // 学校予定をグループ化（アコーディオン表示用）
  const [expandedSchoolGroups, setExpandedSchoolGroups] = useState<Set<string>>(new Set());
  
  // 学校イベントをグループ化
  const schoolGroupsMap = useMemo(() => {
    const schoolEvents = selectedEvents.filter(e => e.source === 'aimo_school_timetable');
    const schoolGroups = new Map<string, FirestoreEvent[]>();
    
    for (const event of schoolEvents) {
      const schoolId = event.external_calendar_id || 'unknown';
      if (!schoolGroups.has(schoolId)) {
        schoolGroups.set(schoolId, []);
      }
      schoolGroups.get(schoolId)!.push(event);
    }
    
    // 各学校グループ内のイベントも時間順にソート - Dateオブジェクトで比較
    for (const [schoolId, eventsInGroup] of schoolGroups.entries()) {
      schoolGroups.set(schoolId, eventsInGroup.sort((a, b) => {
        const timeA = a.start_time || '';
        const timeB = b.start_time || '';
        
        if (!timeA || !timeB) return 0;
        
        const dateA = new Date(timeA);
        const dateB = new Date(timeB);
        
        return dateA.getTime() - dateB.getTime();
      }));
    }
    
    return schoolGroups;
  }, [selectedEvents]);
  
  // すべてのイベントを時間順に並べる（学校イベントは代表イベントのみ）
  const sortedEventsForDisplay = useMemo(() => {
    const result: Array<{ type: 'school' | 'other', event: FirestoreEvent, schoolId?: string }> = [];
    const processedSchoolIds = new Set<string>();
    
    for (const event of selectedEvents) {
      if (event.source === 'aimo_school_timetable') {
        const schoolId = event.external_calendar_id || 'unknown';
        // 学校イベントは代表として1つだけ追加
        if (!processedSchoolIds.has(schoolId)) {
          result.push({ type: 'school', event, schoolId });
          processedSchoolIds.add(schoolId);
        }
      } else {
        result.push({ type: 'other', event });
      }
    }
    
    // 時間順にソート - Dateオブジェクトで比較
    const sorted = result.sort((a, b) => {
      const timeA = a.event.start_time || '';
      const timeB = b.event.start_time || '';
      
      if (!timeA || !timeB) return 0;
      
      // Dateオブジェクトに変換して比較（タイムゾーンを考慮）
      const dateA = new Date(timeA);
      const dateB = new Date(timeB);
      
      return dateA.getTime() - dateB.getTime();
    });
    
    // デバッグログ - 詳細表示
    console.log('[Calendar] ========== イベント表示順序 ==========');
    sorted.forEach((item, index) => {
      const date = new Date(item.event.start_time || '');
      const jstTime = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      console.log(`${index + 1}. [${item.type === 'school' ? '学校' : 'その他'}] ${item.event.title}`);
      console.log(`   DB時刻: ${item.event.start_time}`);
      console.log(`   JST表示: ${jstTime}`);
    });
    console.log('[Calendar] ======================================');
    
    return sorted;
  }, [selectedEvents]);
  
  const toggleSchoolGroup = (schoolId: string) => {
    const newExpanded = new Set(expandedSchoolGroups);
    if (newExpanded.has(schoolId)) {
      newExpanded.delete(schoolId);
    } else {
      newExpanded.add(schoolId);
    }
    setExpandedSchoolGroups(newExpanded);
  };
  
  // 移動時間を含むイベントリスト（選択日のイベント間の移動時間を計算）
  const [eventsWithTravel, setEventsWithTravel] = useState<Array<{ type: 'event' | 'travel', item?: { type: 'school' | 'other', event: FirestoreEvent, schoolId?: string }, travelInfo?: { from: string, to: string, duration: string, mode: string } }>>([]);
  
  useEffect(() => {
    const calculateTravelTimes = async () => {
      if (selectedEvents.length === 0) {
        setEventsWithTravel([]);
        return;
      }
      
      try {
        const settings = await getUserSettings();
        const result: Array<{ type: 'event' | 'travel', item?: { type: 'school' | 'other', event: FirestoreEvent, schoolId?: string }, travelInfo?: { from: string, to: string, duration: string, mode: string } }> = [];
        
        // イベントを時間順に並べる（学校イベントは最初のイベントのみ）
        const sortedEvents = [...selectedEvents].sort((a, b) => {
          const dateA = new Date(a.start_time || '');
          const dateB = new Date(b.start_time || '');
          return dateA.getTime() - dateB.getTime();
        });
        
        for (let i = 0; i < sortedEvents.length; i++) {
          const currentEvent = sortedEvents[i];
          const nextEvent = sortedEvents[i + 1];
          
          // 現在のイベントの場所情報を取得
          let currentLocation: { name?: string; lat?: number; lng?: number; place_id?: string } | null = null;
          if (currentEvent.location_info?.lat && currentEvent.location_info.lng) {
            currentLocation = currentEvent.location_info;
          } else if (currentEvent.source === 'aimo_school_timetable' && schoolProfile?.location) {
            currentLocation = schoolProfile.location;
          } else if (currentEvent.workplace_id) {
            const workplace = settings.shift_workplaces?.find(w => w.id === currentEvent.workplace_id);
            if (workplace?.location) {
              currentLocation = workplace.location;
            }
          }
          
          // 次のイベントの場所情報を取得
          let nextLocation: { name?: string; lat?: number; lng?: number; place_id?: string } | null = null;
          if (nextEvent) {
            if (nextEvent.location_info?.lat && nextEvent.location_info.lng) {
              nextLocation = nextEvent.location_info;
            } else if (nextEvent.source === 'aimo_school_timetable' && schoolProfile?.location) {
              nextLocation = schoolProfile.location;
            } else if (nextEvent.workplace_id) {
              const workplace = settings.shift_workplaces?.find(w => w.id === nextEvent.workplace_id);
              if (workplace?.location) {
                nextLocation = workplace.location;
              }
            }
          }
          
          // イベントを追加
          const eventItem = sortedEventsForDisplay.find(e => 
            (e.type === 'school' && e.schoolId && currentEvent.source === 'aimo_school_timetable' && currentEvent.external_calendar_id === e.schoolId) ||
            (e.type === 'other' && e.event.id === currentEvent.id)
          );
          if (eventItem) {
            result.push({ type: 'event', item: eventItem });
          }
          
          // 移動時間を計算（次のイベントがあり、両方に場所情報がある場合）
          if (nextEvent && currentLocation && nextLocation && 
              currentLocation.lat && currentLocation.lng && 
              nextLocation.lat && nextLocation.lng &&
              (currentLocation.place_id !== nextLocation.place_id)) {
            try {
              // 移動手段を決定
              let travelMode: 'transit' | 'driving' | 'walking' | 'bicycling' = 'transit';
              if (nextEvent.source === 'aimo_school_timetable' && schoolProfile?.preferred_travel_mode) {
                travelMode = schoolProfile.preferred_travel_mode;
              } else if (nextEvent.workplace_id) {
                const workplace = settings.shift_workplaces?.find(w => w.id === nextEvent.workplace_id);
                if (workplace?.preferred_travel_mode) {
                  travelMode = workplace.preferred_travel_mode;
                }
              } else if (settings.preferred_travel_mode) {
                travelMode = settings.preferred_travel_mode;
              }
              
              // 移動時間を計算
              const travelResponse = await fetch('/api/location/travel-time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  origin: { lat: currentLocation.lat, lng: currentLocation.lng },
                  destination: { lat: nextLocation.lat, lng: nextLocation.lng },
                  mode: travelMode
                })
              });
              
              if (travelResponse.ok) {
                const travelData = await travelResponse.json();
                if (travelData.success) {
                  const modeLabel = travelMode === 'transit' ? '公共交通機関' : 
                                   travelMode === 'driving' ? '車' : 
                                   travelMode === 'bicycling' ? '自転車' : '徒歩';
                  result.push({
                    type: 'travel',
                    travelInfo: {
                      from: currentLocation.name || '',
                      to: nextLocation.name || '',
                      duration: travelData.duration_text || '',
                      mode: modeLabel
                    }
                  });
                }
              }
            } catch (error) {
              console.error('[Calendar] Travel time calculation error:', error);
            }
          }
        }
        
        setEventsWithTravel(result);
      } catch (error) {
        console.error('[Calendar] Failed to calculate travel times:', error);
        // エラー時は移動時間なしでイベントのみ表示
        setEventsWithTravel(sortedEventsForDisplay.map(item => ({ type: 'event' as const, item })));
      }
    };
    
    calculateTravelTimes();
  }, [selectedEvents, sortedEventsForDisplay, schoolProfile]);
  
  // 学校イベントの担当者名を更新
  const updateSchoolEventTeacher = async (eventId: string, classes: any[]) => {
    try {
      // descriptionを再構築
      const newDescription = classes.map(cls => 
        `${cls.period}限: ${cls.subject}${cls.location ? ` (${cls.location})` : ''}`
      ).join('\n');
      
      await updateEvent(eventId, { description: newDescription });
      
      // 学校プロファイルも更新
      const settings = await getUserSettings();
      const school = settings.school_profiles?.[0];
      
      if (school) {
        // scheduleを更新
        const updatedSchedule = school.schedule.map((s: any) => {
          const updated = classes.find(c => c.period === s.period);
          if (updated && updated.location) {
            return { ...s, location: updated.location, teacher: updated.location };
          }
          return s;
        });
        
        // undefinedフィールドを除外
        const cleanSchedule = updatedSchedule.map((c: any) => {
          const cleaned: any = {
            day: c.day,
            period: c.period,
            subject: c.subject
          };
          if (c.teacher !== undefined && c.teacher !== null) cleaned.teacher = c.teacher;
          if (c.location !== undefined && c.location !== null) cleaned.location = c.location;
          if (c.isOnline !== undefined && c.isOnline !== null) cleaned.isOnline = c.isOnline;
          return cleaned;
        });
        
        const updatedProfile = { ...school, schedule: cleanSchedule };
        const updatedProfiles = [updatedProfile, ...(settings.school_profiles || []).slice(1, 3)];
        
        await updateUserSettings({ school_profiles: updatedProfiles });
        console.log('[Calendar] Updated school profile');
      }
      
      // イベントを再読み込み
      await loadEvents();
      setEditingSchoolEvent(null);
      
      alert('担当者名を更新しました！');
    } catch (e: any) {
      console.error('[Calendar] Failed to update teacher:', e);
      alert(e?.message || '更新に失敗しました');
    }
  };

  const handleDeleteEvent = async (eventId: string | undefined, title: string) => {
    if (!eventId) return;
    if (!confirm(`「${title}」を削除しますか？`)) return;
    try {
      await deleteEvent(eventId);
      loadEvents(); // 再読み込み
    } catch (e: any) {
      alert(e?.message ?? '削除に失敗しました');
    }
  };

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>カレンダー</h2>
        <button 
          className="btn primary" 
          onClick={() => openAddModal()}
          style={{ fontSize: 15, padding: '10px 20px' }}
        >
          ＋ 新規予定を追加
        </button>
      </div>
      
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        {/* カレンダーグリッド */}
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <button className="btn secondary" onClick={() => setActiveDate(addDays(activeDate, -30))}>{'<'}</button>
            <strong style={{ fontSize: 18 }}>{format(activeDate, 'yyyy年MM月')}</strong>
            <button className="btn secondary" onClick={() => setActiveDate(addDays(activeDate, 30))}>{'>'}</button>
          </div>
          
          {/* レジェンド（凡例） */}
          <div style={{ 
            marginBottom: 12, 
            padding: 12, 
            background: 'var(--bg)', 
            borderRadius: 6,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 12
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: '#93c5fd', display: 'inline-block' }} />
              <span>学校</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: '#10b981', display: 'inline-block' }} />
              <span>バイト</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: '#4285F4', display: 'inline-block' }} />
              <span>Google</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: '#0078D4', display: 'inline-block' }} />
              <span>Outlook</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: '#007AFF', display: 'inline-block' }} />
              <span>iCloud</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {['日','月','火','水','木','金','土'].map((w, idx) => {
              let color = 'var(--muted)';
              if (idx === 0) color = '#dc2626'; // 日曜日は赤
              if (idx === 6) color = '#2563eb'; // 土曜日は青
              
              return (
                <div key={w} style={{ fontSize: 12, color, textAlign: 'center', padding: '4px 0', fontWeight: 500 }}>{w}</div>
              );
            })}
            {calendarDays.map((d) => {
              const k = dateKey(d);
              const dayEvents = eventMap.get(k) ?? [];
              const isCurrentMonth = isSameMonth(d, activeDate);
              const isSelected = isSameDay(selectedDate, d);
              const isToday = isSameDay(d, new Date());
              
              // 曜日と祝日の判定
              const dayOfWeek = d.getDay(); // 0=日, 6=土
              const dateStr = format(d, 'yyyy-MM-dd');
              const isHoliday = JAPANESE_HOLIDAYS_2025.includes(dateStr);
              
              // 日付の色を決定
              let dateColor = 'var(--text)';
              if (dayOfWeek === 0 || isHoliday) {
                dateColor = '#dc2626'; // 日曜日・祝日は赤
              } else if (dayOfWeek === 6) {
                dateColor = '#2563eb'; // 土曜日は青
              }
              
              return (
                <button
                  key={d.toISOString()}
                  onClick={() => setSelectedDate(d)}
                  onDoubleClick={() => openAddModal(d)}
                  style={{
                    padding: '6px 4px',
                    opacity: isCurrentMonth ? 1 : 0.4,
                    border: `2px solid ${isSelected ? 'var(--primary)' : isToday ? '#16a34a' : 'var(--border)'}`,
                    borderRadius: 8,
                    background: isSelected ? '#eff6ff' : 'var(--card)',
                    cursor: 'pointer',
                    position: 'relative',
                    minHeight: 70,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'flex-start',
                    color: 'var(--text)'
                  }}
                  className={isSelected ? 'calendar-day-selected' : ''}
                >
                  <div style={{ 
                    fontSize: 14, 
                    fontWeight: isToday ? 600 : 400, 
                    color: dateColor,
                    marginBottom: 4,
                    alignSelf: 'center'
                  }}>
                    {format(d, 'd')}
                  </div>
                  
                  {/* バー表示 */}
                  {dayEvents.length > 0 && (
                    <div style={{ 
                      width: '100%', 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: 2 
                    }}>
                      {dayEvents.slice(0, 3).map((ev, i) => (
                        <div 
                          key={i} 
                          style={{ 
                            height: 3,
                            borderRadius: 2,
                            background: getEventColor(ev),
                            width: '100%'
                          }} 
                        />
                      ))}
                      {dayEvents.length > 3 && (
                        <div style={{ 
                          fontSize: 9, 
                          color: 'var(--muted)', 
                          textAlign: 'center',
                          marginTop: 2
                        }}>
                          +{dayEvents.length - 3}
                        </div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 選択日の詳細 */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>
              {format(selectedDate, 'yyyy年MM月dd日（EEE）', { locale: ja })}
              {isSameDay(selectedDate, new Date()) && (
                <span style={{ 
                  marginLeft: 8, 
                  fontSize: 12, 
                  padding: '2px 8px', 
                  background: '#16a34a', 
                  color: 'white',
                  borderRadius: 12
                }}>
                  今日
                </span>
              )}
            </h3>
            {loading && <span style={{ color: 'var(--muted)', fontSize: 12 }}>読み込み中...</span>}
          </div>
          
          {error && <div style={{ color: '#b91c1c', marginBottom: 12 }}>{error}</div>}
          
          {selectedEvents.length === 0 ? (
            <div style={{ 
              textAlign: 'center', 
              padding: 32
            }}>
              <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 16 }}>
                この日の予定はありません
              </div>
              <button 
                className="btn secondary" 
                onClick={() => openAddModal(selectedDate)}
                style={{ fontSize: 14 }}
              >
                ＋ この日に予定を追加
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: 'grid', gap: 12 }}>
              {/* すべてのイベントを時間順に表示（移動時間を含む） */}
              {eventsWithTravel.length > 0 ? eventsWithTravel.map((entry, index) => {
                // 移動時間ブロック
                if (entry.type === 'travel' && entry.travelInfo) {
                  return (
                    <div
                      key={`travel-${index}`}
                      className="card"
                      style={{
                        padding: 12,
                        borderLeft: '4px solid #6b7280',
                        background: '#f9fafb',
                        opacity: 0.8
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>
                            移動（{entry.travelInfo.mode}）
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                            {entry.travelInfo.from} → {entry.travelInfo.to}（{entry.travelInfo.duration}）
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                
                // イベントブロック
                if (entry.type === 'event' && entry.item) {
                  const item = entry.item;
                if (item.type === 'school' && item.schoolId) {
                  // 学校イベントの表示
                  const schoolId = item.schoolId;
                  const schoolEvs = schoolGroupsMap.get(schoolId) || [];
                  const isExpanded = expandedSchoolGroups.has(schoolId);
                  const firstEvent = schoolEvs[0];
                  
                  if (!firstEvent) return null;
                
                // descriptionから授業情報をパースし、学校プロファイルからオンライン情報を取得
                const parseClasses = (description: string | null | undefined) => {
                  if (!description) return [];
                  // "1限: AI概論\n2限: AI概論\n3限: AI概論" のような形式をパース
                  const lines = description.split('\n').filter(l => l.trim());
                  return lines.map(line => {
                    const match = line.match(/(\d+)限:\s*(.+?)(?:\s*\((.+?)\))?$/);
                    if (match) {
                      const [, period, subject, location] = match;
                      const periodNum = parseInt(period);
                      
                      // 学校プロファイルから該当する授業を探してオンライン情報を取得
                      const dayOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][selectedDate.getDay()];
                      
                      const classInfo = schoolProfile?.schedule?.find((c: any) => 
                        c.day === dayOfWeek && c.period === periodNum
                      );
                      
                      return { 
                        period: periodNum, 
                        subject: subject.trim(), 
                        location: location?.trim(),
                        isOnline: classInfo?.isOnline || false
                      };
                    }
                    return null;
                  }).filter((c): c is NonNullable<typeof c> => c !== null);
                };
                
                const classes = parseClasses(firstEvent.description);
                const totalClasses = classes.length;
                
                // 開始・終了時刻を取得
                const startTime = formatTimeRange(firstEvent.start_time, null).split(' - ')[0];
                const endTime = formatTimeRange(null, firstEvent.end_time);
                
                // 編集中かどうか
                const isEditing = editingSchoolEvent?.eventId === firstEvent.id;
                const editClasses = isEditing && editingSchoolEvent ? editingSchoolEvent.classes : classes;
                
                return (
                  <div key={`school-${schoolId}`}>
                    {/* 学校グループヘッダー */}
                    <div 
                      className="card" 
                      style={{ 
                        padding: 12,
                        borderLeft: `4px solid #93c5fd`,
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                      onClick={() => toggleSchoolGroup(schoolId)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 16 }}>{isExpanded ? '▼' : '▶'}</span>
                            <span style={{
                              width: 12,
                              height: 12,
                              borderRadius: '50%',
                              background: '#93c5fd',
                              display: 'inline-block'
                            }} />
                            <strong style={{ fontSize: 16 }}>[学校]</strong>
                            <span style={{ fontSize: 13, color: '#6b7280' }}>
                              ({totalClasses}コマ)
                            </span>
                          </div>
                          <div style={{ fontSize: 14, color: '#6b7280', marginLeft: 36, marginTop: 4 }}>
                            {startTime} - {endTime}
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* 時間割テーブル（展開時） */}
                    {isExpanded && (
                      <div style={{ marginLeft: 20, marginTop: 8 }}>
                        <div className="card" style={{ padding: 16, background: '#f0f9ff' }}>
                          <div style={{ marginBottom: 12 }}>
                            <strong style={{ fontSize: 15, color: '#0c4a6e' }}>
                              {firstEvent.title}
                            </strong>
                          </div>
                          
                          {/* 時間割テーブル */}
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ 
                              width: '100%', 
                              borderCollapse: 'collapse',
                              backgroundColor: 'white',
                              fontSize: 13
                            }}>
                              <thead>
                                <tr>
                                  <th style={{ 
                                    border: '1px solid #d1d5db', 
                                    padding: 8,
                                    backgroundColor: '#f3f4f6',
                                    fontWeight: 600,
                                    textAlign: 'center',
                                    width: 60
                                  }}>時限</th>
                                  <th style={{ 
                                    border: '1px solid #d1d5db', 
                                    padding: 8,
                                    backgroundColor: '#f3f4f6',
                                    fontWeight: 600,
                                    textAlign: 'center',
                                    width: 100
                                  }}>時間</th>
                                  <th style={{ 
                                    border: '1px solid #d1d5db', 
                                    padding: 8,
                                    backgroundColor: '#f3f4f6',
                                    fontWeight: 600,
                                    textAlign: 'left'
                                  }}>科目名</th>
                                  <th style={{ 
                                    border: '1px solid #d1d5db', 
                                    padding: 8,
                                    backgroundColor: '#f3f4f6',
                                    fontWeight: 600,
                                    textAlign: 'left',
                                    width: 120
                                  }}>担当者名</th>
                                </tr>
                              </thead>
                              <tbody>
                                {editClasses.map((cls, idx) => {
                                  // 学校プロファイルから時間を取得
                                  const timing = schoolTimings.find(t => t.period === cls.period);
                                  const timeStr = timing ? `${timing.start}-${timing.end}` : '-';
                                  
                                  return (
                                    <tr key={idx}>
                                      <td style={{ 
                                        border: '1px solid #d1d5db', 
                                        padding: 8,
                                        textAlign: 'center',
                                        fontWeight: 600,
                                        color: '#065f46',
                                        backgroundColor: '#f9fafb'
                                      }}>
                                        {cls.period}限
                                      </td>
                                      <td style={{ 
                                        border: '1px solid #d1d5db', 
                                        padding: 8,
                                        textAlign: 'center',
                                        fontSize: 12,
                                        color: '#6b7280',
                                        whiteSpace: 'nowrap',
                                        backgroundColor: '#f9fafb'
                                      }}>
                                        {timeStr}
                                      </td>
                                      <td style={{ 
                                        border: '1px solid #d1d5db', 
                                        padding: 8
                                      }}>
                                        <div>
                                          <div style={{ 
                                            display: 'flex', 
                                            alignItems: 'center', 
                                            gap: 6,
                                            flexWrap: 'wrap',
                                            marginBottom: 4
                                          }}>
                                            <span style={{ fontWeight: 500 }}>{cls.subject}</span>
                                            {cls.isOnline && (
                                              <span style={{
                                                fontSize: 9,
                                                padding: '2px 6px',
                                                background: '#dbeafe',
                                                color: '#1e40af',
                                                borderRadius: 3,
                                                fontWeight: 600,
                                                whiteSpace: 'nowrap'
                                              }}>
                                                オンライン
                                              </span>
                                            )}
                                          </div>
                                          {cls.meeting_link && (
                                            <a
                                              href={cls.meeting_link}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              style={{
                                                color: '#3b82f6',
                                                textDecoration: 'none',
                                                fontSize: 10,
                                                padding: '2px 6px',
                                                background: '#eff6ff',
                                                borderRadius: 3,
                                                border: '1px solid #3b82f6',
                                                display: 'inline-block'
                                              }}
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              🔗 参加
                                            </a>
                                          )}
                                        </div>
                                      </td>
                                      <td style={{ 
                                        border: '1px solid #d1d5db', 
                                        padding: 8,
                                        fontSize: 12,
                                        color: '#6b7280'
                                      }}>
                                        {isEditing ? (
                                          <input
                                            type="text"
                                            value={cls.location || ''}
                                            onChange={(e) => {
                                              if (editingSchoolEvent) {
                                                const updated = [...editingSchoolEvent.classes];
                                                updated[idx] = { ...updated[idx], location: e.target.value };
                                                setEditingSchoolEvent({ ...editingSchoolEvent, classes: updated });
                                              }
                                            }}
                                            placeholder="担当者名"
                                            onClick={(e) => e.stopPropagation()}
                                            style={{
                                              width: '100%',
                                              padding: '4px 8px',
                                              fontSize: 12,
                                              border: '1px solid #3b82f6',
                                              borderRadius: 4,
                                              backgroundColor: '#eff6ff'
                                            }}
                                          />
                                        ) : (
                                          cls.location || '-'
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          
                          {/* アクションボタン */}
                          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              {isEditing ? (
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <button
                                    className="btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (firstEvent.id && editingSchoolEvent) {
                                        updateSchoolEventTeacher(firstEvent.id, editingSchoolEvent.classes);
                                      }
                                    }}
                                    style={{ fontSize: 12, padding: '6px 16px', background: '#16a34a' }}
                                  >
                                    保存
                                  </button>
                                  <button
                                    className="btn secondary"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingSchoolEvent(null);
                                    }}
                                    style={{ fontSize: 12, padding: '6px 16px' }}
                                  >
                                    キャンセル
                                  </button>
                                </div>
                              ) : (
                                <button
                                  className="btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingSchoolEvent({ 
                                      eventId: firstEvent.id || '', 
                                      classes: [...classes] 
                                    });
                                  }}
                                  style={{ fontSize: 12, padding: '6px 16px', background: '#0284c7' }}
                                >
                                  担当者を編集
                                </button>
                              )}
                            </div>
                            <button
                              className="btn secondary"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Google スプレッドシート用TSV形式でエクスポート
                                const tsv = ['時限\t時間\t科目名\t担当者名'];
                                editClasses.forEach(cls => {
                                  const timing = schoolTimings.find(t => t.period === cls.period);
                                  const timeStr = timing ? `${timing.start}-${timing.end}` : '';
                                  tsv.push(`${cls.period}限\t${timeStr}\t${cls.subject}\t${cls.location || ''}`);
                                });
                                const blob = new Blob([tsv.join('\n')], { type: 'text/tab-separated-values;charset=utf-8;' });
                                const link = document.createElement('a');
                                link.href = URL.createObjectURL(blob);
                                link.download = `時間割_${format(selectedDate, 'yyyy-MM-dd')}.tsv`;
                                link.click();
                              }}
                              style={{ fontSize: 12, padding: '6px 12px' }}
                            >
                              スプレッドシートにエクスポート
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
                } else {
                  // その他のイベントの表示
                  const ev = item.event;
                  return (
                <div 
                  key={`other-${ev.id || index}`} 
                  className="card" 
                  style={{ 
                    padding: 16,
                    borderLeft: `4px solid ${getEventColor(ev)}`
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: getEventColor(ev),
                          display: 'inline-block',
                          flexShrink: 0
                        }} />
                        <strong style={{ fontSize: 16 }}>{ev.title}</strong>
                      </div>
                      <div style={{ fontSize: 18, color: 'var(--text)', marginBottom: 8, fontWeight: 500 }}>
                        {formatTimeRange(ev.start_time, ev.end_time)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontFamily: 'monospace' }}>
                        [時刻] {ev.start_time} → {ev.end_time}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {getCategoryLabel(ev.category)}
                      </div>
                      {(ev.location || ev.location_info) && (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                          <div style={{ marginBottom: 2 }}>
                            [場所] {ev.location || ev.location_info?.name || ''}
                          </div>
                          {ev.location_info?.address && (
                            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                              {ev.location_info.address}
                            </div>
                          )}
                          {ev.location_info?.lat && ev.location_info?.lng && (
                            <a
                              href={`https://www.google.com/maps?q=${ev.location_info.lat},${ev.location_info.lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: '#3b82f6',
                                textDecoration: 'none',
                                fontSize: 12,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4
                              }}
                            >
                              地図で開く
                            </a>
                          )}
                        </div>
                      )}
                      
                      {/* 参加者 */}
                      {ev.attendees && ev.attendees.length > 0 && (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
                          <strong>参加者:</strong> {ev.attendees.join(', ')}
                        </div>
                      )}
                      
                      {/* 会議リンク */}
                      {ev.meeting_link && (
                        <div style={{ fontSize: 13, marginTop: 6 }}>
                          <strong>会議:</strong>{' '}
                          <a 
                            href={ev.meeting_link} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{ 
                              color: '#2563eb', 
                              textDecoration: 'underline',
                              cursor: 'pointer'
                            }}
                          >
                            {ev.meeting_link}
                          </a>
                        </div>
                      )}
                      
                      {/* アジェンダ */}
                      {ev.agenda && ev.agenda.length > 0 && (
                        <div style={{ marginTop: 8, padding: 8, background: '#f0f9ff', borderRadius: 4 }}>
                          <strong style={{ fontSize: 13, color: '#3b82f6' }}>アジェンダ:</strong>
                          <ol style={{ paddingLeft: 20, marginTop: 6, marginBottom: 0 }}>
                            {ev.agenda.map((item: string, idx: number) => (
                              <li key={idx} style={{ fontSize: 12, marginBottom: 4 }}>
                                {item}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button 
                        className="btn" 
                        onClick={() => openEditModal(ev)}
                        style={{ fontSize: 12, padding: '4px 12px' }}
                      >
                        編集
                      </button>
                      <button 
                        className="btn secondary" 
                        onClick={() => handleDeleteEvent(ev.id, ev.title)}
                        style={{ fontSize: 12, padding: '4px 12px' }}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
                  );
                }
              }
              return null;
              }) : null}
              </div>
              
              {/* 予定がある日にも追加ボタンを表示 */}
              <div style={{ 
                textAlign: 'center', 
                padding: 16,
                marginTop: 12,
                borderTop: '1px dashed #e5e7eb'
              }}>
                <button 
                  className="btn secondary" 
                  onClick={() => openAddModal(selectedDate)}
                  style={{ fontSize: 14 }}
                >
                  ＋ この日に予定を追加
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* 編集モーダル */}
      {editingEvent && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            backdropFilter: 'blur(4px)'
          }}
          onClick={closeEditModal}
        >
          <div 
            style={{
              background: 'white',
              borderRadius: 12,
              padding: 24,
              maxWidth: 600,
              width: '90%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
              border: '1px solid rgba(0, 0, 0, 0.1)'
            }}
            onClick={(e) => e.stopPropagation()}
            className="edit-modal-content"
          >
            <h3 style={{ marginBottom: 20 }}>予定を編集</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* タイトル */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  タイトル
                </label>
                <input
                  type="text"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
              </div>
              
              {/* 日付表示 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  日付
                </label>
                {!showEditDatePicker ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ 
                      fontSize: 16, 
                      padding: '8px 12px', 
                      background: '#f3f4f6',
                      borderRadius: 6,
                      flex: 1
                    }}>
                      {editForm.date ? format(new Date(editForm.date), 'yyyy年MM月dd日') : ''}
                    </span>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setShowEditDatePicker(true)}
                      style={{ fontSize: 13, padding: '6px 12px', whiteSpace: 'nowrap' }}
                    >
                      日付を変更
                    </button>
                  </div>
                ) : (
                  <input
                    type="date"
                    value={editForm.date}
                    onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 6
                    }}
                  />
                )}
              </div>
              
              {/* 開始時刻 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  開始時刻
                </label>
                <input
                  type="time"
                  value={editForm.start_time}
                  onChange={(e) => setEditForm({ ...editForm, start_time: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 16
                  }}
                />
              </div>
              
              {/* 終了時刻 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  終了時刻
                </label>
                <input
                  type="time"
                  value={editForm.end_time}
                  onChange={(e) => setEditForm({ ...editForm, end_time: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 16
                  }}
                />
              </div>
              
              {/* 場所 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  場所
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={editForm.location}
                    onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
                    placeholder="例: 会議室A"
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 6
                    }}
                  />
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => startLocationSearch('edit')}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    場所を検索
                  </button>
                </div>
                {editForm.locationInfo && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    <div style={{ color: 'var(--muted)', marginBottom: 2 }}>
                      ✓ {editForm.locationInfo.name}
                    </div>
                    {editForm.locationInfo.address && (
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>
                        {editForm.locationInfo.address}
                      </div>
                    )}
                    {editForm.locationInfo.lat && editForm.locationInfo.lng && (
                      <a
                        href={`https://www.google.com/maps?q=${editForm.locationInfo.lat},${editForm.locationInfo.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: '#3b82f6',
                          textDecoration: 'none',
                          fontSize: 11,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        地図で開く
                      </a>
                    )}
                  </div>
                )}
              </div>
              
              {/* 参加者 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  参加者（カンマ区切り）
                </label>
                <input
                  type="text"
                  value={editForm.attendees}
                  onChange={(e) => setEditForm({ ...editForm, attendees: e.target.value })}
                  placeholder="例: 田中太郎, 山田花子"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
              </div>
              
              {/* 会議リンク */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  会議リンク
                </label>
                <input
                  type="url"
                  value={editForm.meeting_link}
                  onChange={(e) => setEditForm({ ...editForm, meeting_link: e.target.value })}
                  placeholder="例: https://zoom.us/j/123456789"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
                {editForm.meeting_link && (
                  <div style={{ marginTop: 6, fontSize: 12 }}>
                    <a 
                      href={editForm.meeting_link} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ 
                        color: '#2563eb', 
                        textDecoration: 'underline',
                        cursor: 'pointer'
                      }}
                    >
                      リンクを開く ↗
                    </a>
                  </div>
                )}
              </div>
              
              {/* アジェンダ */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  アジェンダ（1行に1項目）
                </label>
                <textarea
                  value={editForm.agenda}
                  onChange={(e) => setEditForm({ ...editForm, agenda: e.target.value })}
                  placeholder="例:&#10;自己紹介&#10;プロジェクトの進捗確認&#10;次回アクション"
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontFamily: 'inherit',
                    resize: 'vertical'
                  }}
                />
              </div>
              
              {/* カスタムカラー */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  カスタムカラー（任意）
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="color"
                    value={editForm.custom_color || '#10b981'}
                    onChange={(e) => setEditForm({ ...editForm, custom_color: e.target.value })}
                    style={{
                      width: 60,
                      height: 40,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      {editForm.custom_color ? 'カスタムカラー設定中' : 'デフォルトカラーを使用'}
                    </div>
                    {editForm.custom_color && (
                      <button
                        className="btn secondary"
                        onClick={() => setEditForm({ ...editForm, custom_color: '' })}
                        style={{ fontSize: 12, padding: '4px 8px', marginTop: 4 }}
                      >
                        デフォルトに戻す
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
              <button 
                className="btn secondary" 
                onClick={closeEditModal}
                style={{ padding: '8px 16px' }}
              >
                キャンセル
              </button>
              <button 
                className="btn" 
                onClick={saveEdit}
                style={{ padding: '8px 16px' }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 新規予定追加モーダル */}
      {showAddModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20
        }}>
          <div style={{
            background: 'var(--card)',
            borderRadius: 12,
            padding: 24,
            maxWidth: 600,
            width: '100%',
            maxHeight: '90vh',
            overflowY: 'auto'
          }}>
            <h3 style={{ marginTop: 0, marginBottom: 20 }}>新規予定を追加</h3>
            
            <div style={{ display: 'grid', gap: 16 }}>
              {/* タイトル */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  タイトル <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  value={newEventForm.title}
                  onChange={(e) => setNewEventForm({ ...newEventForm, title: e.target.value })}
                  placeholder="例: チーム定例会議"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
              </div>
              
              {/* カテゴリー */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  カテゴリー
                </label>
                <select
                  value={newEventForm.category}
                  onChange={(e) => setNewEventForm({ ...newEventForm, category: e.target.value as any })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                >
                  <option value="work_study">仕事・勉強</option>
                  <option value="life_chores">生活・雑務</option>
                  <option value="leisure">余暇</option>
                  <option value="other">その他</option>
                </select>
              </div>
              
              {/* 日付表示 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  日付
                </label>
                {!showDatePicker ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ 
                      fontSize: 16, 
                      padding: '8px 12px', 
                      background: '#f3f4f6',
                      borderRadius: 6,
                      flex: 1
                    }}>
                      {format(new Date(newEventForm.date), 'yyyy年MM月dd日')}
                    </span>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setShowDatePicker(true)}
                      style={{ fontSize: 13, padding: '6px 12px', whiteSpace: 'nowrap' }}
                    >
                      日付を変更
                    </button>
                  </div>
                ) : (
                  <input
                    type="date"
                    value={newEventForm.date}
                    onChange={(e) => setNewEventForm({ ...newEventForm, date: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 6
                    }}
                  />
                )}
              </div>
              
              {/* 開始時刻 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  開始時刻 <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="time"
                  value={newEventForm.start_time}
                  onChange={(e) => setNewEventForm({ ...newEventForm, start_time: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 16
                  }}
                />
              </div>
              
              {/* 終了時刻 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  終了時刻
                </label>
                <input
                  type="time"
                  value={newEventForm.end_time}
                  onChange={(e) => setNewEventForm({ ...newEventForm, end_time: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 16
                  }}
                />
              </div>
              
              {/* 場所 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  場所
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={newEventForm.location}
                    onChange={(e) => setNewEventForm({ ...newEventForm, location: e.target.value })}
                    placeholder="例: 会議室A"
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 6
                    }}
                  />
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => startLocationSearch('new')}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    場所を検索
                  </button>
                </div>
                {newEventForm.locationInfo && (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    <div style={{ color: 'var(--muted)', marginBottom: 2 }}>
                      ✓ {newEventForm.locationInfo.name}
                    </div>
                    {newEventForm.locationInfo.address && (
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 4 }}>
                        {newEventForm.locationInfo.address}
                      </div>
                    )}
                    {newEventForm.locationInfo.lat && newEventForm.locationInfo.lng && (
                      <a
                        href={`https://www.google.com/maps?q=${newEventForm.locationInfo.lat},${newEventForm.locationInfo.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: '#3b82f6',
                          textDecoration: 'none',
                          fontSize: 11,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        地図で開く
                      </a>
                    )}
                  </div>
                )}
              </div>
              
              {/* 参加者 */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  参加者（カンマ区切り）
                </label>
                <input
                  type="text"
                  value={newEventForm.attendees}
                  onChange={(e) => setNewEventForm({ ...newEventForm, attendees: e.target.value })}
                  placeholder="例: 田中太郎, 山田花子"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
              </div>
              
              {/* 会議リンク */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  会議リンク
                </label>
                <input
                  type="url"
                  value={newEventForm.meeting_link}
                  onChange={(e) => setNewEventForm({ ...newEventForm, meeting_link: e.target.value })}
                  placeholder="例: https://zoom.us/j/123456789"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6
                  }}
                />
              </div>
              
              {/* アジェンダ */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  アジェンダ（1行に1項目）
                </label>
                <textarea
                  value={newEventForm.agenda}
                  onChange={(e) => setNewEventForm({ ...newEventForm, agenda: e.target.value })}
                  placeholder="例:&#10;自己紹介&#10;プロジェクトの進捗確認&#10;次回アクション"
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontFamily: 'inherit',
                    resize: 'vertical'
                  }}
                />
              </div>
              
              {/* カスタムカラー */}
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                  カスタムカラー（任意）
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="color"
                    value={newEventForm.custom_color || '#10b981'}
                    onChange={(e) => setNewEventForm({ ...newEventForm, custom_color: e.target.value })}
                    style={{
                      width: 60,
                      height: 40,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      cursor: 'pointer'
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      {newEventForm.custom_color ? 'カスタムカラー設定中' : 'デフォルトカラーを使用'}
                    </div>
                    {newEventForm.custom_color && (
                      <button
                        className="btn secondary"
                        onClick={() => setNewEventForm({ ...newEventForm, custom_color: '' })}
                        style={{ fontSize: 12, padding: '4px 8px', marginTop: 4 }}
                      >
                        デフォルトに戻す
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'flex-end' }}>
              <button 
                className="btn secondary" 
                onClick={closeAddModal}
                style={{ padding: '8px 16px' }}
              >
                キャンセル
              </button>
              <button 
                className="btn primary" 
                onClick={saveNewEvent}
                style={{ padding: '8px 16px' }}
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 場所検索モーダル */}
      {showLocationSearch && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: 16
          }}
          onClick={() => setShowLocationSearch(false)}
        >
          <div
            className="card"
            style={{
              maxWidth: 500,
              width: '100%',
              maxHeight: '80vh',
              overflow: 'auto',
              padding: 20
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>場所を検索</h3>
            
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                className="input"
                type="text"
                placeholder="例: 神戸電子専門学校, カフェXX"
                value={locationSearchQuery}
                onChange={(e) => setLocationSearchQuery(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    searchLocation();
                  }
                }}
                style={{ flex: 1 }}
              />
              <button
                className="btn"
                onClick={searchLocation}
                disabled={searchingLocation || !locationSearchQuery.trim()}
              >
                {searchingLocation ? '検索中...' : '検索'}
              </button>
            </div>
            
            {locationCandidates.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {locationCandidates.map((candidate, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: 12,
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6
                    }}
                  >
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => selectLocation(candidate)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: 0,
                        background: 'transparent',
                        border: 'none'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{candidate.name}</div>
                      {candidate.address && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                          {candidate.address}
                        </div>
                      )}
                    </button>
                    {candidate.lat && candidate.lng && (
                      <a
                        href={`https://www.google.com/maps?q=${candidate.lat},${candidate.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          color: '#3b82f6',
                          textDecoration: 'none',
                          fontSize: 11,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                      >
                        地図で開く
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
            
            {locationCandidates.length === 0 && locationSearchQuery && !searchingLocation && (
              <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>
                検索結果が見つかりませんでした
              </p>
            )}
            
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  setShowLocationSearch(false);
                  setLocationCandidates([]);
                  setLocationSearchQuery('');
                }}
                style={{ flex: 1 }}
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
