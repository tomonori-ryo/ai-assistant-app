"use client";
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { addEvent, addTask, getUserSettings, type WorkplaceProfile, addSubtasks, type ConnectedCalendar } from '../../lib/firestore';
import { calculatePriorityScore } from '../../lib/priority';
import { auth } from '../../lib/firebase';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

type ParsedEvent = {
  type: 'event' | 'task' | 'update' | 'delete' | 'null';
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  due_date?: string | null;
  duration?: number | null;
  category?: 'work_study' | 'life_chores' | 'leisure' | 'other' | null;
  location?: string | null;
  target_id?: string | null;
  target_kind?: 'event' | 'task' | null;
  should_subdivide?: boolean;
} | null;

type SubtaskSuggestion = {
  title: string;
};

const SUGGESTIONS = [
  '今日の予定を整理して',
  '今の空き時間にできることは？',
  '25日 歯医者 15時で登録',
  '来週の勉強計画を立てて',
  '集中時間を確保して'
];

export default function ChatPage() {
  const searchParams = useSearchParams();
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'assistant', content: 'こんにちは。今日は何を進めますか？' }
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [preview, setPreview] = useState<ParsedEvent>(null);
  const [assistantReply, setAssistantReply] = useState<string>("");
  const listRef = useRef<HTMLDivElement>(null);
  
  // タスク細分化フロー用
  const [suggestedSubtasks, setSuggestedSubtasks] = useState<SubtaskSuggestion[]>([]);
  const [isSubdividing, setIsSubdividing] = useState(false);
  
  // 外部カレンダー書き込みフロー用
  const [showWriteToExternal, setShowWriteToExternal] = useState(false);
  const [lastRegisteredEventId, setLastRegisteredEventId] = useState<string | null>(null);
  const [connectedCalendars, setConnectedCalendars] = useState<ConnectedCalendar[]>([]);
  const [writingToExternal, setWritingToExternal] = useState(false);
  const [lastExternalWrite, setLastExternalWrite] = useState<{
    event_id: string;
    external_event_id: string;
    calendar_id: string;
    calendar_name: string;
  } | null>(null);
  
  // AIフォーカスタイム提案用
  const [focusTimeSuggestion, setFocusTimeSuggestion] = useState<any>(null);
  const [reservingFocusTime, setReservingFocusTime] = useState(false);
  
  // AI予定詳細・アジェンダ提案用
  const [showAgendaSuggestion, setShowAgendaSuggestion] = useState(false);
  const [agendaSuggestion, setAgendaSuggestion] = useState<any>(null);
  const [eventDetails, setEventDetails] = useState<any>(null);
  const [loadingAgenda, setLoadingAgenda] = useState(false);
  const [pendingEventData, setPendingEventData] = useState<any>(null);
  const [awaitingDetailsInput, setAwaitingDetailsInput] = useState(false);
  const [detailsQuestions, setDetailsQuestions] = useState<string[]>([]);
  
  // バイト先判別フロー用
  const [shiftImageData, setShiftImageData] = useState<string | null>(null);
  const [shiftFilename, setShiftFilename] = useState<string | null>(null);
  const [workplaces, setWorkplaces] = useState<WorkplaceProfile[]>([]);
  const [awaitingWorkplaceSelection, setAwaitingWorkplaceSelection] = useState(false);
  const [detectedWorkplace, setDetectedWorkplace] = useState<{ workplace: WorkplaceProfile; confidence: number } | null>(null);

  // ホーム画面からのシフト画像アップロード
  useEffect(() => {
    const isShiftUpload = searchParams?.get('shift_upload') === 'true';
    if (!isShiftUpload) return;
    
    const imageData = localStorage.getItem('pending_shift_image');
    const filename = localStorage.getItem('pending_shift_filename');
    
    if (imageData && filename) {
      console.log('[Chat] Shift upload detected:', filename);
      setShiftImageData(imageData);
      setShiftFilename(filename);
      
      // バイト先プロファイルを取得
      (async () => {
        try {
          const settings = await getUserSettings();
          const workplaceList = settings.shift_workplaces || [];
          
          // 後方互換：shift_search_nameがあれば自動でworkplacesに変換
          if (!workplaceList.length && settings.shift_search_name) {
            workplaceList.push({
              id: 'default',
              name: 'バイト先',
              search_name: settings.shift_search_name,
              keywords: []
            });
          }
          
          setWorkplaces(workplaceList);
          
          if (workplaceList.length === 0) {
            // バイト先未設定
            setMessages([{
              role: 'assistant',
              content: 'シフト表の画像ですね。設定でバイト先プロファイルを登録してください。'
            }]);
          } else if (workplaceList.length === 1) {
            // パターンA：バイト先が1つ → 自動解析（確認なし）
            setMessages([{
              role: 'assistant',
              content: `シフト表の画像ですね。「${workplaceList[0].name}」のシフトとして解析します...`
            }]);
            executeOCR(workplaceList[0], false);
          } else {
            // パターンB：バイト先が複数 → まず自動判別を試みる
            setMessages([{
              role: 'assistant',
              content: 'シフト表の画像を確認しています...'
            }]);
            setThinking(true);
            
            // 自動判別実行（OCRのみ、スケジュール解析はしない）
            tryAutoDetect(imageData, workplaceList);
          }
        } catch (e: any) {
          console.error('[Chat] Failed to load workplaces:', e);
          setMessages([{
            role: 'assistant',
            content: '設定の読み込みに失敗しました。もう一度お試しください。'
          }]);
        }
      })();
      
      // localStorageをクリア
      localStorage.removeItem('pending_shift_image');
      localStorage.removeItem('pending_shift_filename');
    }
  }, [searchParams]);
  
  // ホーム画面からの遷移時、初期メッセージを自動送信
  useEffect(() => {
    const contextStr = localStorage.getItem('chat_context');
    if (contextStr) {
      try {
        const context = JSON.parse(contextStr);
        if (context.initial_message && context.from === 'home') {
          localStorage.removeItem('chat_context'); // 使い終わったら削除
          setInput(context.initial_message);
          // 少し遅延させてから自動送信
          setTimeout(() => send(context.initial_message), 500);
        }
      } catch (e) {
        console.error('[Chat] Failed to parse context:', e);
      }
    }
    
    // 外部カレンダー連携状況を取得
    (async () => {
      try {
        const settings = await getUserSettings();
        if (settings.connected_calendars) {
          setConnectedCalendars(settings.connected_calendars);
        }
      } catch (e) {
        console.error('[Chat] Failed to load settings:', e);
      }
    })();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking, preview]);

  const executeOCR = async (workplace: WorkplaceProfile, userCorrected = false) => {
    if (!shiftImageData) return;
    console.log('[Chat] Executing OCR for workplace:', workplace.name, 'userCorrected:', userCorrected);
    setAwaitingWorkplaceSelection(false);
    setThinking(true);
    
    try {
      // Base64 → Blob → File変換
      const blob = await fetch(shiftImageData).then(r => r.blob());
      const file = new File([blob], shiftFilename || 'shift.jpg', { type: 'image/jpeg' });
      
      const form = new FormData();
      form.append('image', file);
      form.append('type', 'schedule_table');
      form.append('shift_name', workplace.search_name);
      
      const res = await fetch('/api/ocr', { method: 'POST', body: form });
      const json = await res.json();
      
      // ユーザーが推測を修正した場合、再学習を提案
      if (userCorrected && json.status === 'success') {
        localStorage.setItem('suggest_relearn', JSON.stringify({
          workplace_id: workplace.id,
          workplace_name: workplace.name,
          ocr_text: json.raw_ocr_text
        }));
      }
      
      if (json?.extracted_events && json.extracted_events.length > 0) {
        // OCR成功 → OCRページに遷移
        localStorage.setItem('ocr_preview', JSON.stringify(json.extracted_events));
        setMessages((m) => [...m, {
          role: 'assistant',
          content: `[完了] ${json.extracted_events.length}件の予定を抽出しました。確認画面に移動します...`
        }]);
        setTimeout(() => {
          window.location.href = '/ocr';
        }, 1000);
      } else {
        setMessages((m) => [...m, {
          role: 'assistant',
          content: '予定を抽出できませんでした。画像が明るく、文字がはっきり見えるか確認してください。'
        }]);
      }
    } catch (e: any) {
      console.error('[Chat] OCR error:', e);
      setMessages((m) => [...m, {
        role: 'assistant',
        content: `解析に失敗しました: ${e?.message ?? '不明なエラー'}`
      }]);
    } finally {
      setThinking(false);
      setShiftImageData(null);
      setShiftFilename(null);
    }
  };

  const tryAutoDetect = async (imageBase64: string, workplaceList: WorkplaceProfile[]) => {
    try {
      // Base64 → Blob → File変換
      const blob = await fetch(imageBase64).then(r => r.blob());
      const file = new File([blob], shiftFilename || 'shift.jpg', { type: 'image/jpeg' });
      
      const form = new FormData();
      form.append('image', file);
      form.append('type', 'schedule_table');
      form.append('workplaces', JSON.stringify(workplaceList));
      
      const res = await fetch('/api/ocr', { method: 'POST', body: form });
      const json = await res.json();
      
      setThinking(false);
      
      const detected = json.detected_workplace;
      const confidence = detected?.confidence || 0;
      
      if (confidence >= 70) {
        // 高確率推測 → 確認を求める
        const matchedWorkplace = workplaceList.find(wp => wp.id === detected.id);
        if (matchedWorkplace) {
          setDetectedWorkplace({ workplace: matchedWorkplace, confidence });
          setMessages((m) => [...m, {
            role: 'assistant',
            content: `このシフト表は「**${detected.name}**」のものですか？（確率: ${confidence}%）`
          }]);
          setAwaitingWorkplaceSelection(true);
        } else {
          // マッチしたバイト先が見つからない場合
          setMessages((m) => [...m, {
            role: 'assistant',
            content: 'これは、**どちらのバイト先**のものですか？'
          }]);
          setAwaitingWorkplaceSelection(true);
        }
      } else {
        // 低確率 → すべてのバイト先を表示
        setDetectedWorkplace(null);
        setMessages((m) => [...m, {
          role: 'assistant',
          content: '新しい形式のシフト表ですね。これは、**どちらのバイト先**のものですか？'
        }]);
        setAwaitingWorkplaceSelection(true);
      }
    } catch (e: any) {
      console.error('[Chat] Auto-detect error:', e);
      setThinking(false);
      setMessages((m) => [...m, {
        role: 'assistant',
        content: '画像の解析に失敗しました。もう一度お試しください。'
      }]);
    }
  };

  const selectWorkplace = (workplace: WorkplaceProfile, isCorrection = false) => {
    setMessages((m) => [...m, {
      role: 'user',
      content: workplace.name
    }]);
    executeOCR(workplace, isCorrection);
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content) return;
    setMessages((m) => [...m, { role: 'user', content }]);
    setInput("");
    setThinking(true);
    setSuggestedSubtasks([]); // リセット
    
    console.log('[Chat] Send - awaitingDetailsInput:', awaitingDetailsInput, 'pendingEventData:', pendingEventData);
    
    // 詳細情報入力待ちの場合
    if (awaitingDetailsInput && pendingEventData) {
      console.log('[Chat] Processing additional details:', content);
      // 「このまま登録」と入力された場合
      if (content.includes('このまま') || content.includes('登録')) {
        setAwaitingDetailsInput(false);
        setDetailsQuestions([]);
        
        // アジェンダ提案を表示
        setShowAgendaSuggestion(true);
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: `「${pendingEventData.title}」について、AIが話すべき議題（アジェンダ）の候補を準備しますか？` 
        }]);
        setThinking(false);
        return;
      }
      
      // 詳細情報を再抽出
      try {
        const detailsRes = await fetch('/api/event/extract-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_input: content,
            parsed_event: pendingEventData
          })
        });
        
        const detailsData = await detailsRes.json();
        
        if (detailsData.success) {
          // 詳細情報を更新
          const updatedEventData = { ...pendingEventData };
          if (detailsData.attendees?.length > 0) {
            updatedEventData.attendees = [...(updatedEventData.attendees || []), ...detailsData.attendees];
          }
          if (detailsData.meeting_link) updatedEventData.meeting_link = detailsData.meeting_link;
          if (detailsData.meeting_type) updatedEventData.meeting_type = detailsData.meeting_type;
          if (detailsData.location_detail) updatedEventData.location = detailsData.location_detail;
          
          setPendingEventData(updatedEventData);
          
          // 更新された情報を表示
          const updatedInfo: string[] = [];
          if (detailsData.attendees?.length > 0) updatedInfo.push(`参加者: ${detailsData.attendees.join(', ')}`);
          if (detailsData.meeting_link) updatedInfo.push(`会議: ${detailsData.meeting_link}`);
          if (detailsData.location_detail) updatedInfo.push(`場所: ${detailsData.location_detail}`);
          
          if (updatedInfo.length > 0) {
            setMessages((m) => [...m, { 
              role: 'assistant', 
              content: `以下の情報を追加しました：\n${updatedInfo.join('\n')}\n\n他に追加情報があればお知らせください。準備ができたら「アジェンダを提案」と入力してください。` 
            }]);
          } else {
            setMessages((m) => [...m, { 
              role: 'assistant', 
              content: '情報を確認しました。他に追加情報があればお知らせください。準備ができたら「アジェンダを提案」と入力してください。' 
            }]);
          }
        }
        
        setThinking(false);
        return;
      } catch (e) {
        console.error('[Chat] Failed to process additional details:', e);
        setThinking(false);
        return;
      }
    }
    
    // フォーカスタイム関連のキーワードを検出
    const focusKeywords = ['集中時間', 'フォーカス', '集中タイム', '作業時間を確保'];
    const isFocusTimeRequest = focusKeywords.some(keyword => content.includes(keyword));
    
    if (isFocusTimeRequest) {
      setThinking(false);
      requestFocusTimeSuggestion();
      return;
    }
    
    // アジェンダ提案のキーワード検出
    if (awaitingDetailsInput && (content.includes('アジェンダ') || content.includes('議題'))) {
      setAwaitingDetailsInput(false);
      setDetailsQuestions([]);
      setShowAgendaSuggestion(true);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `「${pendingEventData?.title}」について、AIが話すべき議題（アジェンダ）の候補を準備しますか？` 
      }]);
      setThinking(false);
      return;
    }
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, context: 'schedule_input' })
      });
      const json = await res.json();
      const parsedEvent = json.parsed_event ?? null;
      
      setAssistantReply(json.ai_response ?? '');
      setPreview(parsedEvent);
      setMessages((m) => [...m, { role: 'assistant', content: json.ai_response ?? '' }]);
      
      // 予定の場合、詳細情報を自動抽出
      if (parsedEvent?.type === 'event' && parsedEvent?.title && content) {
        try {
          const detailsRes = await fetch('/api/event/extract-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_input: content,
              parsed_event: parsedEvent
            })
          });
          
          const detailsData = await detailsRes.json();
          if (detailsData.success) {
            setEventDetails(detailsData);
            
            // 明確化が必要な質問がある場合、詳細入力モードに
            if (detailsData.clarification_questions?.length > 0) {
              console.log('[Chat] Clarification needed (from preview), setting awaitingDetailsInput to true');
              setDetailsQuestions(detailsData.clarification_questions);
              setAwaitingDetailsInput(true);
              
              // プレビューデータを一時保存
              const eventData = {
                title: parsedEvent.title,
                start_time: parsedEvent.start_time,
                end_time: parsedEvent.end_time,
                category: parsedEvent.category ?? 'other',
                location: detailsData.location_detail || parsedEvent.location,
                attendees: detailsData.attendees || [],
                meeting_link: detailsData.meeting_link,
                meeting_type: detailsData.meeting_type
              };
              
              setPendingEventData(eventData);
              console.log('[Chat] Pending event data set (from preview):', eventData);
              
              setMessages((m) => [...m, { 
                role: 'assistant', 
                content: `この予定について、以下の情報を追加できます：\n${detailsData.clarification_questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\n追加情報を入力してください。` 
              }]);
              
              // プレビューをクリア（詳細入力モードに入る）
              setPreview(null);
            }
          }
        } catch (e) {
          console.error('[Chat] Failed to extract event details:', e);
        }
      }
      
      // タスクで細分化が推奨される場合、AIに細分化を依頼
      if (parsedEvent?.type === 'task' && parsedEvent?.should_subdivide && parsedEvent?.title) {
        setIsSubdividing(true);
        trySubdivide(parsedEvent.title);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: 'エラーが発生しました。もう一度お試しください。' }]);
    } finally {
      setThinking(false);
    }
  };
  
  const trySubdivide = async (taskTitle: string) => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: taskTitle,
          context: 'task_subdivision'
        })
      });
      const json = await res.json();
      
      // AIレスポンスからサブタスクを抽出
      const aiResponse = json.ai_response || '';
      const match = aiResponse.match(/\{[\s\S]*?\}/);
      
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.subtasks && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
            setSuggestedSubtasks(parsed.subtasks);
            setMessages((m) => [...m, { 
              role: 'assistant', 
              content: `[AI] タスクを${parsed.subtasks.length}つに細分化しました。プレビューを確認してください。` 
            }]);
          }
        } catch (e) {
          console.error('[Chat] Failed to parse subdivision:', e);
        }
      }
    } catch (e: any) {
      console.error('[Chat] Subdivision error:', e);
    } finally {
      setIsSubdividing(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    console.log('[Chat] Confirming preview:', preview);
    
    try {
      if (preview.type === 'event') {
        if (!preview.title || !preview.start_time) {
          throw new Error('タイトルまたは開始時間が不足しています');
        }
        
        // まず、AI詳細抽出を実行
        try {
          const detailsRes = await fetch('/api/event/extract-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_input: messages.slice(-2).map(m => m.content).join('\n'),
              parsed_event: preview
            })
          });
          
          const detailsData = await detailsRes.json();
          
          if (detailsData.success) {
            setEventDetails(detailsData);
            
            // 詳細情報をプレビューに反映
            const detailsInfo: string[] = [];
            if (detailsData.attendees?.length > 0) {
              detailsInfo.push(`参加者: ${detailsData.attendees.join(', ')}`);
            }
            if (detailsData.meeting_link) {
              detailsInfo.push(`会議: ${detailsData.meeting_link}`);
            }
            if (detailsData.purpose) {
              detailsInfo.push(`目的: ${detailsData.purpose}`);
            }
            
            // 詳細情報をAIメッセージとして追加
            if (detailsInfo.length > 0) {
              setMessages((m) => [...m, { 
                role: 'assistant', 
                content: `以下の詳細情報を自動で追加しました：\n${detailsInfo.join('\n')}` 
              }]);
            }
            
            // 明確化が必要な質問がある場合
            if (detailsData.clarification_questions?.length > 0) {
              console.log('[Chat] Clarification needed, setting awaitingDetailsInput to true');
              setDetailsQuestions(detailsData.clarification_questions);
              setAwaitingDetailsInput(true);
              
              // 現在のプレビューを一時保存
              const eventData = {
                title: preview.title,
                start_time: preview.start_time,
                end_time: preview.end_time,
                category: preview.category ?? 'other',
                location: detailsData.location_detail || preview.location,
                attendees: detailsData.attendees || [],
                meeting_link: detailsData.meeting_link,
                meeting_type: detailsData.meeting_type
              };
              
              setPendingEventData(eventData);
              console.log('[Chat] Pending event data set:', eventData);
              
              setMessages((m) => [...m, { 
                role: 'assistant', 
                content: `この予定について、以下の情報を追加できます：\n${detailsData.clarification_questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\n追加情報を入力してください。` 
              }]);
              
              setPreview(null);
              return;
            }
            
            // アジェンダが必要な予定の場合、確認を取る
            if (detailsData.needs_agenda) {
              setPendingEventData({
                title: preview.title,
                start_time: preview.start_time,
                end_time: preview.end_time,
                category: preview.category ?? 'other',
                location: detailsData.location_detail || preview.location,
                attendees: detailsData.attendees || [],
                meeting_link: detailsData.meeting_link,
                meeting_type: detailsData.meeting_type
              });
              
              setShowAgendaSuggestion(true);
              setMessages((m) => [...m, { 
                role: 'assistant', 
                content: `「${preview.title}」について、AIが話すべき議題（アジェンダ）の候補を準備しますか？` 
              }]);
              setPreview(null);
              return;
            }
          }
        } catch (e) {
          console.error('[Chat] Failed to extract details:', e);
          // 詳細抽出失敗時は通常通り登録
        }
        
        // Firestoreに予定を追加
        const { db, auth: firebaseAuth } = await import('../../lib/firebase').then(m => m.getFirebase());
        const user = firebaseAuth.currentUser;
        if (!user) throw new Error('Not signed in');
        
        const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
        const col = collection(db, 'users', user.uid, 'events');
        
        const eventData: any = {
          title: preview.title,
          start_time: preview.start_time,
          end_time: preview.end_time ?? null,
          category: preview.category ?? 'other',
          location: preview.location ?? null,
          source: 'aimo',
          createdAt: serverTimestamp()
        };
        
        // 詳細情報があれば追加
        if (eventDetails) {
          if (eventDetails.attendees?.length > 0) eventData.attendees = eventDetails.attendees;
          if (eventDetails.meeting_link) eventData.meeting_link = eventDetails.meeting_link;
          if (eventDetails.meeting_type) eventData.meeting_type = eventDetails.meeting_type;
        }
        
        const eventDoc = await addDoc(col, eventData);
        
        console.log('[Chat] Event added successfully with ID:', eventDoc.id);
        setMessages((m) => [...m, { role: 'assistant', content: '[完了] 予定を登録しました。' }]);
        
        // 外部カレンダー連携がある場合、書き込み提案を表示
        if (connectedCalendars.length > 0 && connectedCalendars.some(cal => cal.write_enabled)) {
          setLastRegisteredEventId(eventDoc.id);
          setShowWriteToExternal(true);
          setMessages((m) => [...m, { 
            role: 'assistant', 
            content: 'この予定を連携している外部カレンダーにも書き込みますか？' 
          }]);
        }
        
        setEventDetails(null);
      } else if (preview.type === 'task') {
        if (!preview.title) {
          throw new Error('タイトルが不足しています');
        }
        
        // サブタスクがある場合は親子関係で登録
        if (suggestedSubtasks.length > 0) {
          // 親タスクを追加
          const { db, auth } = await import('../../lib/firebase').then(m => m.getFirebase());
          const user = auth.currentUser;
          if (!user) throw new Error('Not signed in');
          
          const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
          const col = collection(db, 'users', user.uid, 'tasks');
          
          const parentDoc = await addDoc(col, {
            title: preview.title,
            category: preview.category ?? 'other',
            dueDate: preview.due_date ?? null,
            priorityScore: calculatePriorityScore(preview.due_date ?? null, preview.category ?? 'other'),
            location: preview.location ?? null,
            completed: false,
            parent_task_id: null,
            createdAt: serverTimestamp()
          });
          
          // サブタスクを追加
          const subtasksData = suggestedSubtasks.map(st => ({
            title: st.title,
            category: preview.category ?? 'other',
            dueDate: preview.due_date ?? null,
            priorityScore: calculatePriorityScore(preview.due_date ?? null, preview.category ?? 'other')
          }));
          
          await addSubtasks(parentDoc.id, subtasksData as any);
          
          console.log('[Chat] Parent task and subtasks added successfully');
          setMessages((m) => [...m, { 
            role: 'assistant', 
            content: `[完了] タスク「${preview.title}」を${suggestedSubtasks.length}つのサブタスクと共に登録しました。タスクページで確認できます。` 
          }]);
        } else {
          // 通常のタスク登録
          await addTask({
            title: preview.title,
            category: preview.category ?? 'other',
            dueDate: preview.due_date ?? null,
            priorityScore: calculatePriorityScore(preview.due_date ?? null, preview.category ?? 'other'),
            location: preview.location ?? null
          });
          console.log('[Chat] Task added successfully');
          setMessages((m) => [...m, { role: 'assistant', content: '[完了] タスクを登録しました。' }]);
          
          // 締切が近い or 重要なタスクの場合、フォーカスタイムを自動提案
          const shouldSuggestFocusTime = checkIfShouldSuggestFocusTime(preview);
          if (shouldSuggestFocusTime) {
            setTimeout(() => {
              setMessages((m) => [...m, { 
                role: 'assistant', 
                content: 'このタスクのために集中時間を確保しますか？' 
              }]);
              requestFocusTimeSuggestion();
            }, 1000);
          }
        }
      } else {
        throw new Error('サポートされていない種別です');
      }
      
      setPreview(null);
      setSuggestedSubtasks([]);
    } catch (e: any) {
      console.error('[Chat] Confirm error:', e);
      setMessages((m) => [...m, { role: 'assistant', content: `登録に失敗しました: ${e?.message ?? '不明なエラー'}` }]);
    }
  };
  
  const writeToExternalCalendar = async (calendarId: string) => {
    if (!lastRegisteredEventId) return;
    
    setWritingToExternal(true);
    try {
      // Firebase Authから現在のユーザーのUIDを取得
      const user = auth.currentUser;
      if (!user) {
        alert('ログインしてください');
        setWritingToExternal(false);
        return;
      }
      
      const uid = user.uid;
      
      const res = await fetch('/api/calendar/google/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: lastRegisteredEventId,
          calendar_id: calendarId,
          uid
        })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        const calendar = connectedCalendars.find(c => c.id === calendarId);
        setLastExternalWrite({
          event_id: lastRegisteredEventId,
          external_event_id: data.external_event_id,
          calendar_id: calendarId,
          calendar_name: calendar?.calendar_name || 'カレンダー'
        });
        
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: `[完了] ${calendar?.calendar_name || 'Googleカレンダー'}にも書き込みました。` 
        }]);
        setShowWriteToExternal(false);
      } else {
        throw new Error(data.error || '書き込みに失敗しました');
      }
    } catch (e: any) {
      console.error('[Chat] External write error:', e);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `外部カレンダーへの書き込みに失敗しました: ${e?.message}` 
      }]);
    } finally {
      setWritingToExternal(false);
    }
  };
  
  const undoExternalWrite = async () => {
    if (!lastExternalWrite) return;
    
    setWritingToExternal(true);
    try {
      // Firebase Authから現在のユーザーのUIDを取得
      const user = auth.currentUser;
      if (!user) {
        alert('ログインしてください');
        setWritingToExternal(false);
        return;
      }
      
      const uid = user.uid;
      
      const res = await fetch('/api/calendar/google/write', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: lastExternalWrite.event_id,
          external_event_id: lastExternalWrite.external_event_id,
          calendar_id: lastExternalWrite.calendar_id,
          uid
        })
      });
      
      if (res.ok) {
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: `↩️ ${lastExternalWrite.calendar_name}への書き込みを取り消しました。` 
        }]);
        setLastExternalWrite(null);
      } else {
        const data = await res.json();
        throw new Error(data.error || '取り消しに失敗しました');
      }
    } catch (e: any) {
      console.error('[Chat] Undo error:', e);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `取り消しに失敗しました: ${e?.message}` 
      }]);
    } finally {
      setWritingToExternal(false);
    }
  };

  // タスクがフォーカスタイム提案の対象かを判定
  const checkIfShouldSuggestFocusTime = (task: ParsedEvent): boolean => {
    if (!task || task.type !== 'task') return false;
    
    // 締切が3日以内の場合
    if (task.due_date) {
      const dueDate = new Date(task.due_date);
      const now = new Date();
      const daysUntilDue = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysUntilDue <= 3 && daysUntilDue > 0) {
        return true;
      }
    }
    
    // 重要カテゴリ（仕事・勉強）の場合
    if (task.category === 'work_study') {
      return true;
    }
    
    return false;
  };
  
  // フォーカスタイム提案を取得
  const requestFocusTimeSuggestion = async () => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');
      
      const uid = user.uid;
      
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: '重要なタスクのための集中時間を探しています...' 
      }]);
      
      const res = await fetch('/api/focus-time/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, min_duration_minutes: 90, search_days: 7 })
      });
      
      const data = await res.json();
      
      if (data.status === 'success') {
        setFocusTimeSuggestion(data.suggestion);
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: data.suggestion.reason 
        }]);
      } else if (data.status === 'no_tasks') {
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: data.message 
        }]);
      } else if (data.status === 'no_slots') {
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: data.message 
        }]);
      }
    } catch (e: any) {
      console.error('[Chat] Focus time suggestion error:', e);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `集中時間の提案に失敗しました: ${e?.message}` 
      }]);
    }
  };
  
  // フォーカスタイムを確保
  const reserveFocusTime = async (slot: any) => {
    if (!focusTimeSuggestion) return;
    
    setReservingFocusTime(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');
      
      const uid = user.uid;
      
      // フォーカスタイムをAIMOのDBに登録
      const focusTimeEvent = {
        title: `集中時間：${focusTimeSuggestion.task.title}`,
        start_time: slot.start_time,
        end_time: slot.end_time,
        category: 'work_study' as const,
        source: 'aimo_focus_time' as const,
        focus_time_task_id: focusTimeSuggestion.task.id,
        focus_time_reason: focusTimeSuggestion.reason,
        location: null
      };
      
      await addEvent(focusTimeEvent);
      
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `[完了] 集中時間を確保しました。\n\n外部カレンダーにも書き込みますか？` 
      }]);
      
      setFocusTimeSuggestion(null);
      
      // 外部カレンダー連携があれば書き込み提案
      // （既存の外部カレンダー書き込みフローを利用）
      
    } catch (e: any) {
      console.error('[Chat] Reserve focus time error:', e);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `集中時間の確保に失敗しました: ${e?.message}` 
      }]);
    } finally {
      setReservingFocusTime(false);
    }
  };
  
  // アジェンダを提案して予定を登録
  const requestAgenda = async () => {
    if (!pendingEventData) return;
    
    setLoadingAgenda(true);
    setShowAgendaSuggestion(false);
    
    try {
      const agendaRes = await fetch('/api/event/suggest-agenda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pendingEventData.title,
          description: eventDetails?.purpose,
          attendees: pendingEventData.attendees,
          duration: pendingEventData.end_time ? 
            Math.round((new Date(pendingEventData.end_time).getTime() - new Date(pendingEventData.start_time).getTime()) / 60000) : 
            null
        })
      });
      
      const agendaData = await agendaRes.json();
      
      if (agendaData.success && agendaData.agenda?.length > 0) {
        setAgendaSuggestion(agendaData);
        
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: `アジェンダの候補を作成しました：\n\n${agendaData.agenda.map((item: string, i: number) => `${i + 1}. ${item}`).join('\n')}\n\nこの内容で予定の詳細メモに保存しますか？` 
        }]);
      } else {
        // アジェンダなしで登録
        await saveEventWithAgenda([]);
      }
    } catch (e) {
      console.error('[Chat] Failed to suggest agenda:', e);
      // エラー時はアジェンダなしで登録
      await saveEventWithAgenda([]);
    } finally {
      setLoadingAgenda(false);
    }
  };
  
  // アジェンダなしで予定を登録
  const skipAgenda = async () => {
    setShowAgendaSuggestion(false);
    await saveEventWithAgenda([]);
  };
  
  // アジェンダを含めて予定を登録
  const saveEventWithAgenda = async (agenda: string[]) => {
    if (!pendingEventData) return;
    
    try {
      const { db, auth: firebaseAuth } = await import('../../lib/firebase').then(m => m.getFirebase());
      const user = firebaseAuth.currentUser;
      if (!user) throw new Error('Not signed in');
      
      const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
      const col = collection(db, 'users', user.uid, 'events');
      
      const eventData: any = {
        ...pendingEventData,
        source: 'aimo',
        createdAt: serverTimestamp()
      };
      
      if (agenda.length > 0) {
        eventData.agenda = agenda;
        eventData.description = `【アジェンダ】\n${agenda.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
      }
      
      const eventDoc = await addDoc(col, eventData);
      
      console.log('[Chat] Event with agenda added:', eventDoc.id);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `[完了] 予定を登録しました${agenda.length > 0 ? '（アジェンダ付き）' : ''}。` 
      }]);
      
      setPendingEventData(null);
      setAgendaSuggestion(null);
      setEventDetails(null);
      
      // 外部カレンダー連携がある場合、書き込み提案を表示
      if (connectedCalendars.length > 0 && connectedCalendars.some(cal => cal.write_enabled)) {
        setLastRegisteredEventId(eventDoc.id);
        setShowWriteToExternal(true);
        setMessages((m) => [...m, { 
          role: 'assistant', 
          content: 'この予定を連携している外部カレンダーにも書き込みますか？' 
        }]);
      }
    } catch (e: any) {
      console.error('[Chat] Failed to save event with agenda:', e);
      setMessages((m) => [...m, { 
        role: 'assistant', 
        content: `予定の登録に失敗しました: ${e?.message}` 
      }]);
    }
  };
  
  const modify = () => {
    // Bring fields back into input for correction
    if (!preview) return;
    const base = [preview.title, preview.start_time ?? preview.due_date, preview.location]
      .filter(Boolean)
      .join(' ');
    setInput(base);
  };

  return (
    <div className="chat-container">
      <div ref={listRef} className="chat-messages">
        <div className="chat-center">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <div className="avatar">AI</div>}
              <div className="bubble">{m.content}</div>
              {m.role === 'user' && <div className="avatar">You</div>}
            </div>
          ))}

          {preview && (
            <div className="card" style={{ margin: '8px 0', background: '#eff6ff', border: '1px solid #3b82f6' }}>
              <strong style={{ fontSize: 16 }}>登録プレビュー</strong>
              
              <div style={{ marginTop: 12, padding: 12, background: 'white', borderRadius: 6 }}>
                <div style={{ fontSize: 14, marginBottom: 4 }}>
                  <strong>{preview.type === 'event' ? '[予定]' : '[タスク]'}</strong> {preview.title ?? '-'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {preview.type === 'event' && (
                    <>
                      開始: {preview.start_time ?? '-'} / 終了: {preview.end_time ?? '-'}
                    </>
                  )}
                  {preview.type === 'task' && (
                    <>
                      期限: {preview.due_date ?? '-'}
                    </>
                  )}
                  {' / '}カテゴリ: {preview.category ?? '-'}
                  {preview.location && ` / 場所: ${preview.location}`}
                </div>
                
                {/* AI抽出された詳細情報 */}
                {eventDetails && preview.type === 'event' && (
                  <div style={{ 
                    marginTop: 12, 
                    padding: 12, 
                    background: '#f0f9ff', 
                    borderRadius: 6,
                    fontSize: 13
                  }}>
                    {eventDetails.attendees && eventDetails.attendees.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <strong>参加者:</strong> {eventDetails.attendees.join(', ')}
                      </div>
                    )}
                    {eventDetails.meeting_link && (
                      <div style={{ marginBottom: 6 }}>
                        <strong>会議:</strong>{' '}
                        <a 
                          href={eventDetails.meeting_link} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          style={{ 
                            color: '#2563eb', 
                            textDecoration: 'underline',
                            cursor: 'pointer'
                          }}
                        >
                          {eventDetails.meeting_link}
                        </a>
                      </div>
                    )}
                    {eventDetails.purpose && (
                      <div style={{ marginBottom: 6 }}>
                        <strong>目的:</strong> {eventDetails.purpose}
                      </div>
                    )}
                    {eventDetails.clarification_questions && eventDetails.clarification_questions.length > 0 && (
                      <div style={{ marginTop: 8, color: '#3b82f6' }}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>詳細を追加しますか？</div>
                        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
                          {eventDetails.clarification_questions.map((q: string, i: number) => (
                            <li key={i}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                
                {/* サブタスクプレビュー */}
                {suggestedSubtasks.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#3b82f6' }}>
                      ✨ AIが細分化したサブタスク（{suggestedSubtasks.length}件）
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
                      {suggestedSubtasks.map((st, idx) => (
                        <li key={idx} style={{ marginBottom: 4 }}>{st.title}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button 
                  className="btn" 
                  onClick={confirm}
                  disabled={isSubdividing}
                >
                  {isSubdividing ? '分析中...' : '確定して登録'}
                </button>
                <button className="btn secondary" onClick={modify}>修正</button>
                {suggestedSubtasks.length > 0 && (
                  <button 
                    className="btn secondary" 
                    onClick={() => setSuggestedSubtasks([])}
                    style={{ fontSize: 12 }}
                  >
                    細分化なしで登録
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 詳細情報追加のクイックアクション */}
          {awaitingDetailsInput && pendingEventData && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                {/* 現在の予定情報 */}
                <div style={{ 
                  marginBottom: 16, 
                  padding: 14, 
                  background: '#eff6ff', 
                  borderRadius: 8,
                  fontSize: 14,
                  border: '1px solid #bfdbfe'
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 10, color: '#1e40af', fontSize: 15 }}>
                    現在の予定
                  </div>
                  <div style={{ marginBottom: 6 }}><strong>タイトル:</strong> {pendingEventData.title}</div>
                  <div style={{ marginBottom: 6 }}><strong>日時:</strong> {new Date(pendingEventData.start_time).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  {pendingEventData.attendees?.length > 0 && (
                    <div style={{ marginBottom: 6, color: '#059669' }}><strong>✓ 参加者:</strong> {pendingEventData.attendees.join(', ')}</div>
                  )}
                  {pendingEventData.meeting_link && (
                    <div style={{ marginBottom: 6, color: '#059669' }}>
                      <strong>✓ 会議:</strong>{' '}
                      <a 
                        href={pendingEventData.meeting_link} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        style={{ 
                          color: '#2563eb', 
                          textDecoration: 'underline',
                          cursor: 'pointer'
                        }}
                      >
                        {pendingEventData.meeting_link}
                      </a>
                    </div>
                  )}
                  {pendingEventData.location && (
                    <div style={{ marginBottom: 6, color: '#059669' }}><strong>✓ 場所:</strong> {pendingEventData.location}</div>
                  )}
                  {(!pendingEventData.attendees || pendingEventData.attendees.length === 0) && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
                      チャットで追加情報を入力できます
                    </div>
                  )}
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button
                    className="btn"
                    onClick={() => {
                      setAwaitingDetailsInput(false);
                      setDetailsQuestions([]);
                      setShowAgendaSuggestion(true);
                      setMessages((m) => [...m, { 
                        role: 'user',
                        content: 'アジェンダを提案'
                      }, { 
                        role: 'assistant', 
                        content: `「${pendingEventData.title}」について、AIが話すべき議題（アジェンダ）の候補を準備しますか？` 
                      }]);
                    }}
                    style={{
                      background: '#3b82f6',
                      color: 'white',
                      padding: '12px 20px',
                      width: '100%',
                      fontSize: 15,
                      fontWeight: 600,
                      borderRadius: 8
                    }}
                  >
                    アジェンダを提案
                  </button>
                  <button
                    className="btn secondary"
                    onClick={async () => {
                      setAwaitingDetailsInput(false);
                      setDetailsQuestions([]);
                      setMessages((m) => [...m, { 
                        role: 'user',
                        content: 'このまま登録'
                      }]);
                      await saveEventWithAgenda([]);
                    }}
                    style={{
                      width: '100%',
                      padding: '12px 20px',
                      fontSize: 14,
                      borderRadius: 8
                    }}
                  >
                    このまま登録（アジェンダなし）
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {/* 外部カレンダー書き込み提案 */}
          {/* アジェンダ提案ボタン */}
          {showAgendaSuggestion && pendingEventData && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                  <button
                    className="btn"
                    onClick={requestAgenda}
                    disabled={loadingAgenda}
                    style={{
                      background: loadingAgenda ? '#d1d5db' : '#3b82f6',
                      color: 'white',
                      padding: '12px 20px',
                      width: '100%',
                      fontSize: 15,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: 'none',
                      cursor: loadingAgenda ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8
                    }}
                  >
                    {loadingAgenda ? (
                      <>
                        <span style={{ 
                          display: 'inline-block',
                          width: 14,
                          height: 14,
                          border: '2px solid white',
                          borderTopColor: 'transparent',
                          borderRadius: '50%',
                          animation: 'spin 1s linear infinite'
                        }}></span>
                        <span>AI準備中...</span>
                      </>
                    ) : (
                      'アジェンダを準備してもらう'
                    )}
                  </button>
                  <button
                    className="btn secondary"
                    onClick={skipAgenda}
                    disabled={loadingAgenda}
                    style={{ 
                      width: '100%',
                      padding: '12px 20px',
                      fontSize: 14,
                      borderRadius: 8
                    }}
                  >
                    アジェンダなしで登録
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {/* アジェンダ確定ボタン */}
          {agendaSuggestion && !showAgendaSuggestion && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                  <button
                    className="btn"
                    onClick={() => saveEventWithAgenda(agendaSuggestion.agenda)}
                    style={{
                      background: '#16a34a',
                      color: 'white',
                      padding: '12px 20px',
                      width: '100%',
                      fontSize: 15,
                      fontWeight: 600,
                      borderRadius: 8
                    }}
                  >
                    この内容で保存する
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => saveEventWithAgenda([])}
                    style={{ 
                      width: '100%',
                      padding: '12px 20px',
                      fontSize: 14,
                      borderRadius: 8
                    }}
                  >
                    アジェンダなしで登録
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {showWriteToExternal && connectedCalendars.length > 0 && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {connectedCalendars
                    .filter(cal => cal.write_enabled)
                    .map((cal) => (
                      <button
                        key={cal.id}
                        className="btn"
                        onClick={() => writeToExternalCalendar(cal.id)}
                        disabled={writingToExternal}
                        style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: 8,
                          justifyContent: 'center',
                          width: '100%'
                        }}
                      >
                        <span>
                          {cal.provider === 'google' && '[G]'}
                          {cal.provider === 'outlook' && '[O]'}
                          {cal.provider === 'icloud' && '[i]'}
                        </span>
                        <span>{cal.calendar_name}に書き込む</span>
                      </button>
                    ))}
                  <button
                    className="btn secondary"
                    onClick={() => setShowWriteToExternal(false)}
                    disabled={writingToExternal}
                    style={{ width: '100%' }}
                  >
                    AIMOだけにする
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {/* Undoボタン（外部カレンダーへの書き込み直後に表示） */}
          {lastExternalWrite && !showWriteToExternal && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                <button
                  className="btn secondary"
                  onClick={undoExternalWrite}
                  disabled={writingToExternal}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 8,
                    width: '100%',
                    justifyContent: 'center'
                  }}
                >
                  <span>↩️</span>
                  <span>元に戻す（{lastExternalWrite.calendar_name}への書き込みを取り消す）</span>
                </button>
              </div>
            </div>
          )}
          
          {/* AIフォーカスタイム提案 */}
          {focusTimeSuggestion && (
            <div className="card" style={{ margin: '8px 0', background: '#f3e8ff', border: '1px solid #8b5cf6' }}>
              <strong style={{ fontSize: 16, color: '#8b5cf6' }}>集中時間の提案</strong>
              
              <div style={{ marginTop: 12, padding: 12, background: 'white', borderRadius: 6 }}>
                <div style={{ fontSize: 14, marginBottom: 8 }}>
                  <strong>対象タスク:</strong> {focusTimeSuggestion.task.title}
                </div>
                {focusTimeSuggestion.task.due_date && (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                    締切: {new Date(focusTimeSuggestion.task.due_date).toLocaleDateString('ja-JP')}
                  </div>
                )}
                
                {/* 推奨スロット */}
                <div style={{ 
                  padding: 12, 
                  background: '#f3e8ff',
                  borderRadius: 6,
                  border: '2px solid #8b5cf6',
                  marginBottom: 12
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: '#8b5cf6' }}>
                    [推奨] 第1候補
                  </div>
                  <div style={{ fontSize: 14 }}>
                    {new Date(focusTimeSuggestion.recommended_slot.start_time).toLocaleString('ja-JP', { 
                      month: 'short', 
                      day: 'numeric', 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })} 〜 {new Date(focusTimeSuggestion.recommended_slot.end_time).toLocaleString('ja-JP', { 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    {focusTimeSuggestion.recommended_slot.duration_minutes}分間
                  </div>
                  <button
                    className="btn"
                    onClick={() => reserveFocusTime(focusTimeSuggestion.recommended_slot)}
                    disabled={reservingFocusTime}
                    style={{ width: '100%', marginTop: 8 }}
                  >
                    {reservingFocusTime ? '確保中...' : 'この時間に確保する'}
                  </button>
                </div>
                
                {/* 代替スロット */}
                {focusTimeSuggestion.alternative_slots && focusTimeSuggestion.alternative_slots.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
                      他の候補を見る（{focusTimeSuggestion.alternative_slots.length}件）
                    </summary>
                    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                      {focusTimeSuggestion.alternative_slots.map((slot: any, idx: number) => (
                        <div 
                          key={idx}
                          style={{ 
                            padding: 8, 
                            background: '#fafafa',
                            borderRadius: 4,
                            border: '1px solid #e5e5e5'
                          }}
                        >
                          <div style={{ fontSize: 13 }}>
                            {new Date(slot.start_time).toLocaleString('ja-JP', { 
                              month: 'short', 
                              day: 'numeric', 
                              hour: '2-digit', 
                              minute: '2-digit' 
                            })} 〜 {new Date(slot.end_time).toLocaleString('ja-JP', { 
                              hour: '2-digit', 
                              minute: '2-digit' 
                            })} ({slot.duration_minutes}分)
                          </div>
                          <button
                            className="btn secondary"
                            onClick={() => reserveFocusTime(slot)}
                            disabled={reservingFocusTime}
                            style={{ width: '100%', marginTop: 4, fontSize: 12, padding: '4px 8px' }}
                          >
                            この時間に確保
                          </button>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                
                <button
                  className="btn secondary"
                  onClick={() => setFocusTimeSuggestion(null)}
                  disabled={reservingFocusTime}
                  style={{ width: '100%', marginTop: 12 }}
                >
                  確保しない
                </button>
              </div>
            </div>
          )}

          {awaitingWorkplaceSelection && workplaces.length > 0 && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                {detectedWorkplace ? (
                  // 高確率推測 → Yes/Noボタン
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      className="btn"
                      onClick={() => {
                        setMessages((m) => [...m, { role: 'user', content: 'はい、そうです' }]);
                        executeOCR(detectedWorkplace.workplace, false);
                      }}
                      style={{ flex: 1 }}
                    >
                      ✓ はい、そうです
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        setMessages((m) => [...m, { role: 'user', content: '違います' }]);
                        setDetectedWorkplace(null);
                        setMessages((m) => [...m, {
                          role: 'assistant',
                          content: 'では、**どちらのバイト先**のものですか？'
                        }]);
                      }}
                      style={{ flex: 1 }}
                    >
                      ✕ 違います
                    </button>
                  </div>
                ) : (
                  // 低確率 or 推測却下 → すべてのバイト先ボタン
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    {workplaces.map((wp) => (
                      <button
                        key={wp.id}
                        className="btn secondary"
                        onClick={() => selectWorkplace(wp, true)}
                        style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: 8,
                          justifyContent: 'flex-start',
                          width: '100%'
                        }}
                      >
                        🔘 {wp.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {thinking && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble"><span className="typing"><span></span><span></span><span></span></span></div>
            </div>
          )}

          {!thinking && (
            <div className="chips">
              {SUGGESTIONS.map((c) => (
                <span key={c} className="chip" onClick={() => send(c)}>{c}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer" style={{
          borderColor: awaitingDetailsInput ? '#3b82f6' : undefined,
          borderWidth: awaitingDetailsInput ? '2px' : undefined,
          boxShadow: awaitingDetailsInput ? '0 0 0 3px rgba(59, 130, 246, 0.1)' : undefined
        }}>
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { 
              // IME変換中はEnterを無視（日本語入力対応）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { 
                e.preventDefault(); 
                send(); 
              } 
            }}
            placeholder={
              awaitingDetailsInput 
                ? "詳細情報を入力してください（例: A社の佐藤さんとZoomで）" 
                : "メッセージを入力（例: 25日 15時 歯医者予約 新宿）"
            }
          />
          <button 
            className="btn" 
            onClick={() => send()}
            style={{
              background: awaitingDetailsInput ? '#3b82f6' : undefined
            }}
          >
            {awaitingDetailsInput ? '詳細を追加' : '送信'}
          </button>
        </div>
      </div>
    </div>
  );
}
