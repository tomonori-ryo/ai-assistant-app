"use client";
import { useEffect, useState, useMemo, useRef } from 'react';
import { addEventsBulk, type FirestoreEvent, getUserSettings, getEvents, deleteEvent, updateUserSettings, type WorkplaceProfile, type SchoolProfile, type VacationPeriod } from "../../lib/firestore";
import { calculateSalary } from "../../lib/salaryCalculator";
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale/ja';
import { IconDocument, IconClock, IconCalendar } from "../../components/Icons";

type SortOption = 'date' | 'title';

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '未設定';
  try {
    const parsed = parseISO(iso);
    // ISO文字列がUTCのまま渡されてくるため、表示時はローカルタイムゾーンにずらさず
    // そのままの時刻を表示できるようにオフセット分を戻す
    const adjustMillis = parsed.getTimezoneOffset() * 60 * 1000;
    const displayed = new Date(parsed.getTime() + adjustMillis);
    return format(displayed, 'yyyy年MM月dd日（EEE）HH:mm', { locale: ja });
  } catch {
    return iso;
  }
}

type LoadingStep = {
  step: number;
  total: number;
  message: string;
  progress: number; // 0-100
};

// OCRテキストから自動的にキーワードを抽出
function extractKeywords(ocrText: string): string[] {
  if (!ocrText) return [];
  
  const keywords: string[] = [];
  const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  
  // 店名らしい文字列を抽出（「店」「カフェ」「JR」などを含む行）
  const storePatterns = /店|カフェ|レストラン|JR|駅|支店|本店|バイト|アルバイト/;
  for (const line of lines) {
    if (storePatterns.test(line) && line.length >= 3 && line.length <= 20) {
      keywords.push(line);
    }
  }
  
  // 重複を削除し、最大5個まで
  return [...new Set(keywords)].slice(0, 5);
}

type OcrMode = 'shift' | 'school';

export default function OCRPage() {
  const [mode, setMode] = useState<OcrMode>('shift'); // シフトor学校時間割
  const [file, setFile] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]); // 複数ファイル対応
  const [events, setEvents] = useState<FirestoreEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<LoadingStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('date');
  const [clarificationQuestions, setClarificationQuestions] = useState<string[]>([]);
  const [clarificationAnswer, setClarificationAnswer] = useState<string>('');
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [shiftSearchNameForDisplay, setShiftSearchNameForDisplay] = useState<string>('');
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const hasLoadedFromStorage = useRef(false);
  const [rawOcrText, setRawOcrText] = useState<string>(''); // 自動学習用
  const [askWorkplaceName, setAskWorkplaceName] = useState(false); // バイト先を尋ねる
  const [workplaceNameInput, setWorkplaceNameInput] = useState(''); // ユーザー入力
  const [existingWorkplaces, setExistingWorkplaces] = useState<WorkplaceProfile[]>([]); // 既存バイト先
  const [selectedWorkplaceId, setSelectedWorkplaceId] = useState<string>(''); // 選択されたバイト先
  const [selectedWorkplaceName, setSelectedWorkplaceName] = useState<string>(''); // 選択されたバイト先の名前
  const [isNewWorkplace, setIsNewWorkplace] = useState(false); // 新しいバイト先かどうか
  const [currentFileIndex, setCurrentFileIndex] = useState(0); // 現在処理中のファイル番号
  const [schoolLearningSuccess, setSchoolLearningSuccess] = useState(false); // 学校プロファイル学習成功
  const [schoolLearningInProgress, setSchoolLearningInProgress] = useState(false); // 学校プロファイル学習中
  const [schoolConversation, setSchoolConversation] = useState<Array<{role: 'user' | 'assistant', content: string}>>([]); // 学校時間割の会話履歴
  const [schoolInput, setSchoolInput] = useState(''); // 学校時間割への追加入力
  const [schoolContext, setSchoolContext] = useState<any>(null); // 学校時間割の学習コンテキスト
  const [schoolOcrText, setSchoolOcrText] = useState(''); // 学校時間割のOCR結果
  const [schoolClasses, setSchoolClasses] = useState<any[]>([]); // 学校時間割の構造化データ
  const [schoolFormData, setSchoolFormData] = useState({
    schoolName: '',
    holidayRule: '',
    summerVacation: '',
    winterVacation: '',
    springVacation: '',
    timings: [
      { period: 1, start: '09:20', end: '10:10' },
      { period: 2, start: '10:20', end: '11:10' },
      { period: 3, start: '11:20', end: '12:10' },
      { period: 4, start: '13:10', end: '14:00' },
      { period: 5, start: '14:10', end: '15:00' },
      { period: 6, start: '15:10', end: '16:00' }
    ]
  }); // 学校プロファイルのフォームデータ
  const [showSchoolSettings, setShowSchoolSettings] = useState(false); // 学校設定編集モード

  useEffect(() => {
    (async () => {
      try {
        const settings = await getUserSettings();
        if (settings.shift_search_name) {
          setShiftSearchNameForDisplay(settings.shift_search_name);
        }
        
        // 学校プロファイルを読み込んで自動復元
        if (settings.school_profiles && settings.school_profiles.length > 0) {
          const latestSchool = settings.school_profiles[0]; // 最新の学校プロファイルを使用
          console.log('[OCR Page] Loading saved school profile:', latestSchool.name);
          
          setSchoolFormData({
            schoolName: latestSchool.name || '',
            holidayRule: latestSchool.rules?.national_holidays_jp || '',
            summerVacation: latestSchool.vacations?.find((v: any) => v.start.startsWith('08') || v.start.startsWith('07'))
              ? `${latestSchool.vacations.find((v: any) => v.start.startsWith('08') || v.start.startsWith('07'))?.start} ～ ${latestSchool.vacations.find((v: any) => v.start.startsWith('08') || v.start.startsWith('07'))?.end}`
              : '',
            winterVacation: latestSchool.vacations?.find((v: any) => v.start.startsWith('12') || v.start.startsWith('01'))
              ? `${latestSchool.vacations.find((v: any) => v.start.startsWith('12') || v.start.startsWith('01'))?.start} ～ ${latestSchool.vacations.find((v: any) => v.start.startsWith('12') || v.start.startsWith('01'))?.end}`
              : '',
            springVacation: latestSchool.vacations?.find((v: any) => v.start.startsWith('02') || v.start.startsWith('03') || v.start.startsWith('04'))
              ? `${latestSchool.vacations.find((v: any) => v.start.startsWith('02') || v.start.startsWith('03') || v.start.startsWith('04'))?.start} ～ ${latestSchool.vacations.find((v: any) => v.start.startsWith('02') || v.start.startsWith('03') || v.start.startsWith('04'))?.end}`
              : '',
            timings: latestSchool.timings || [
              { period: 1, start: '09:20', end: '10:10' },
              { period: 2, start: '10:20', end: '11:10' },
              { period: 3, start: '11:20', end: '12:10' },
              { period: 4, start: '13:10', end: '14:00' },
              { period: 5, start: '14:10', end: '15:00' },
              { period: 6, start: '15:10', end: '16:00' }
            ]
          });
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    // localStorageから古いデータを読み込む（ホームページから遷移した場合のみ）
    // 一度だけ実行されるようにフラグで制御
    if (hasLoadedFromStorage.current) return;
    hasLoadedFromStorage.current = true;
    
    try {
      const raw = localStorage.getItem('ocr_preview');
      console.log('[OCR Page] Checking localStorage... raw:', raw ? 'exists' : 'null');
      if (raw) {
        console.log('[OCR Page] Loading from localStorage:', raw);
        const arr = JSON.parse(raw);
        const mapped = arr.map((e: any) => ({
          title: e.title,
          start_time: e.start_time,
          end_time: e.end_time ?? null,
          category: (e.category as any) ?? 'other'
        }));
        console.log('[OCR Page] Events from localStorage:', JSON.stringify(mapped, null, 2));
        console.log('[OCR Page] Setting events from localStorage...');
        setEvents(mapped);
        console.log('[OCR Page] Events set. Removing from localStorage...');
        localStorage.removeItem('ocr_preview');
      }
    } catch (e) {
      console.error('[OCR Page] Error loading from localStorage:', e);
    }
  }, []);


  // 学校時間割のフォーム送信
  // 学校設定を更新して予定を再生成
  const updateSchoolSettings = async () => {
    console.log('[OCR Page] updateSchoolSettings called');
    
    if (!schoolFormData.schoolName.trim()) {
      alert('学校名を入力してください');
      return;
    }
    
    setLoading(true);
    
    try {
      // 既存の学校プロファイルを取得
      const settings = await getUserSettings();
      const existingProfile = settings.school_profiles?.[0];
      
      if (!existingProfile) {
        alert('学校プロファイルが見つかりません。先に時間割を登録してください。');
        setLoading(false);
        return;
      }
      
      // 長期休み情報をパース
      const parseVacation = (vacationStr: string, defaultMonth: string, vacationName: string) => {
        if (!vacationStr || !vacationStr.trim()) return null;
        try {
          // "8月1日 ～ 9月20日" のような形式をパース
          const match = vacationStr.match(/(\d+)月(\d+)日\s*[～〜~-]\s*(\d+)月(\d+)日/);
          if (match) {
            const [, startMonth, startDay, endMonth, endDay] = match;
            return {
              name: vacationName,
              start: `${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
              end: `${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`
            };
          }
        } catch (e) {
          console.error('[OCR Page] Failed to parse vacation:', vacationStr, e);
        }
        return null;
      };
      
      const vacations: Array<{ name: string; start: string; end: string }> = [
        parseVacation(schoolFormData.summerVacation, '08', '夏休み'),
        parseVacation(schoolFormData.winterVacation, '12', '冬休み'),
        parseVacation(schoolFormData.springVacation, '03', '春休み')
      ].filter((v): v is { name: string; start: string; end: string } => v !== null);
      
      // scheduleをクリーニング（undefinedを除外）
      const cleanSchedule = existingProfile.schedule.map((c: any) => {
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
      
      // 更新されたプロファイルを作成
      const updatedProfile: SchoolProfile = {
        ...existingProfile,
        name: schoolFormData.schoolName,
        schedule: cleanSchedule,
        timings: schoolFormData.timings,
        rules: {
          national_holidays_jp: schoolFormData.holidayRule as 'OFF' | 'ON'
        },
        vacations: vacations
      };
      
      // プロファイルを保存
      const updatedProfiles: SchoolProfile[] = [updatedProfile, ...(settings.school_profiles || []).slice(1, 3)];
      await updateUserSettings({
        school_profiles: updatedProfiles
      });
      
      console.log('[OCR Page] Updated school profile, now regenerating events...');
      
      // 既存の学校イベントを削除
      const { getEvents, deleteEvent, addEventsBulk } = await import('../../lib/firestore');
      const allEvents = await getEvents();
      const schoolEvents = allEvents.filter((e: any) => e.source === 'aimo_school_timetable');
      console.log('[OCR Page] Deleting', schoolEvents.length, 'existing school events');
      
      for (const event of schoolEvents) {
        await deleteEvent(event.id!);
      }
      
      // 新しい期間で授業を再生成
      const school = updatedProfile;
      const today = new Date();
      const endDate = new Date();
      
      // 次の長期休みまでの期間を計算
      const currentMonth = today.getMonth() + 1;
      const currentYear = today.getFullYear();
      
      let targetEndDate: Date;
      
      try {
        if (currentMonth >= 1 && currentMonth <= 3) {
          if (school.vacations?.some((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'))) {
            const springVacation = school.vacations.find((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'));
            if (springVacation && springVacation.start) {
              const [month, day] = springVacation.start.split('-').map(Number);
              targetEndDate = new Date(currentYear, month - 1, day);
            } else {
              targetEndDate = new Date(currentYear, 2, 31);
            }
          } else {
            targetEndDate = new Date(currentYear, 2, 31);
          }
        } else if (currentMonth >= 4 && currentMonth <= 7) {
          if (school.vacations?.some((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'))) {
            const summerVacation = school.vacations.find((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'));
            if (summerVacation && summerVacation.start) {
              const [month, day] = summerVacation.start.split('-').map(Number);
              targetEndDate = new Date(currentYear, month - 1, day);
            } else {
              targetEndDate = new Date(currentYear, 6, 31);
            }
          } else {
            targetEndDate = new Date(currentYear, 6, 31);
          }
        } else {
          if (school.vacations?.some((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'))) {
            const winterVacation = school.vacations.find((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'));
            if (winterVacation && winterVacation.start) {
              const [month, day] = winterVacation.start.split('-').map(Number);
              const targetYear = month === 12 ? currentYear : currentYear + 1;
              targetEndDate = new Date(targetYear, month - 1, day);
            } else {
              targetEndDate = new Date(currentYear, 11, 31);
            }
          } else {
            targetEndDate = new Date(currentYear, 11, 31);
          }
        }
      } catch (e) {
        console.error('[OCR Page] Failed to calculate target end date:', e);
        // フォールバック: 3ヶ月後
        targetEndDate = new Date(today);
        targetEndDate.setMonth(targetEndDate.getMonth() + 3);
      }
      
      endDate.setTime(targetEndDate.getTime());
      console.log('[OCR Page] Regenerating classes from', today.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
      
      const japaneseHolidays2025 = [
        '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
        '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05',
        '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23',
        '2025-10-13', '2025-11-03', '2025-11-23', '2025-11-24'
      ];
      
      const generatedEvents = [];
      
      for (let date = new Date(today); date <= endDate; date.setDate(date.getDate() + 1)) {
        // ローカル時間で日付文字列を生成（タイムゾーンのずれを防ぐ）
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;
        
        if (school.rules?.national_holidays_jp === 'OFF' && japaneseHolidays2025.includes(dateStr)) {
          continue;
        }
        
        const monthDay = `${month}-${day}`;
        const isVacation = school.vacations?.some((v: any) => monthDay >= v.start && monthDay <= v.end);
        if (isVacation) {
          continue;
        }
        
        const dayOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getDay()];
        const classesForDay = school.schedule.filter((c: any) => c.day === dayOfWeek).sort((a: any, b: any) => a.period - b.period);
        
        if (classesForDay.length === 0) continue;
        
        const timingsForDay = classesForDay
          .map((cls: any) => {
            const timing = school.timings?.find((t: any) => t.period === cls.period);
            if (!timing) return null;
            return { ...timing, subject: cls.subject, location: cls.location } as { start: string; end: string; period: number; subject: string; location?: string };
          })
          .filter((v: any): v is { start: string; end: string; period: number; subject: string; location?: string } => v !== null);
        
        if (timingsForDay.length === 0) continue;
        
        const firstClass = timingsForDay[0];
        const lastClass = timingsForDay[timingsForDay.length - 1];
        
        const startTimeStr = `${dateStr}T${firstClass.start}:00+09:00`;
        const endTimeStr = `${dateStr}T${lastClass.end}:00+09:00`;
        
        const startTimeISO = new Date(startTimeStr).toISOString();
        const endTimeISO = new Date(endTimeStr).toISOString();
        
        const classDetails = classesForDay.map((cls: any) => 
          `${cls.period}限: ${cls.subject}${cls.location ? ` (${cls.location})` : ''}`
        ).join('\n');
        
        generatedEvents.push({
          title: school.name || '学校',
          description: classDetails,
          start_time: startTimeISO,
          end_time: endTimeISO,
          category: 'work_study' as const,
          location: null,
          source: 'aimo_school_timetable' as const,
          external_id: `school_default_${dateStr}`,
          external_calendar_id: 'school_default',
          is_read_only: false,
          sync_status: null
        });
      }
      
      console.log('[OCR Page] Generated', generatedEvents.length, 'new events');
      
      if (generatedEvents.length > 0) {
        await addEventsBulk(generatedEvents);
        console.log('[OCR Page] Successfully added', generatedEvents.length, 'events');
      }
      
      alert(`学校設定を更新し、予定を再生成しました！\n（${generatedEvents.length}件のイベントを登録）`);
      setShowSchoolSettings(false);
      
    } catch (e: any) {
      console.error('[OCR Page] Failed to update school settings:', e);
      alert(e?.message ?? '学校設定の更新に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const submitSchoolForm = async () => {
    console.log('[OCR Page] submitSchoolForm called');
    console.log('[OCR Page] schoolClasses:', schoolClasses);
    console.log('[OCR Page] schoolClasses.length:', schoolClasses.length);
    console.log('[OCR Page] schoolFormData:', schoolFormData);
    
    if (!schoolFormData.schoolName.trim()) {
      alert('学校名を入力してください');
      return;
    }
    
    if (schoolClasses.length === 0) {
      console.error('[OCR Page] No school classes data!');
      alert('時間割データがありません。写真を撮り直してください。');
      return;
    }
    
    setLoading(true);
    
    // フォームデータを整形（時間割情報を含む）
    let formMessage = `
学校名: ${schoolFormData.schoolName}
祝日ルール: ${schoolFormData.holidayRule || '休講'}
夏休み: ${schoolFormData.summerVacation || '未設定'}
冬休み: ${schoolFormData.winterVacation || '未設定'}
春休み: ${schoolFormData.springVacation || '未設定'}

授業時間:
${schoolFormData.timings?.map(t => `${t.period}限: ${t.start}-${t.end}`).join('\n') || '未設定'}

時間割情報:
`;
    
    // 編集された授業データを追加
    const classesByDay: { [key: string]: any[] } = {};
    for (const cls of schoolClasses) {
      if (!classesByDay[cls.day_of_week]) {
        classesByDay[cls.day_of_week] = [];
      }
      classesByDay[cls.day_of_week].push(cls);
    }
    
    for (const day of ['月', '火', '水', '木', '金']) {
      if (classesByDay[day]) {
        formMessage += `\n${day}曜日:\n`;
        for (const cls of classesByDay[day].sort((a: any, b: any) => a.period - b.period)) {
          formMessage += `  ${cls.period}限 (${cls.start_time}-${cls.end_time}): ${cls.subject}`;
          if (cls.teacher) {
            formMessage += ` [${cls.teacher}]`;
          }
          formMessage += '\n';
        }
      }
    }
    
    const newConversation = [
      ...schoolConversation,
      { role: 'user' as const, content: formMessage.trim() }
    ];
    setSchoolConversation(newConversation);
    
    try {
      const learnRes = await fetch('/api/school/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_input: formMessage,
          context: {
            ...schoolContext,
            conversationHistory: newConversation
          },
          timetable_classes: schoolClasses,
          timings: schoolFormData.timings || [] // ユーザーが設定した時限の時刻を送信
        })
      });
      
      if (!learnRes.ok) {
        throw new Error('学校情報の保存に失敗しました');
      }
      
      const learnJson = await learnRes.json();
      console.log('[OCR Page] School form submit result:', learnJson);
      
      const updatedConversation = [
        ...newConversation,
        { role: 'assistant' as const, content: learnJson.reply || '' }
      ];
      setSchoolConversation(updatedConversation);
      
      setSchoolContext({
        learningProfile: learnJson.updated_profile,
        conversationHistory: updatedConversation
      });
      
      if (learnJson.is_complete) {
          console.log('[OCR Page] Form submit - Learning complete, generating school events...');
          // 学校プロファイルが完成したので、授業予定を生成してカレンダーに登録
          try {
            // クライアント側のFirestoreを使って直接イベントを追加
            const { addEventsBulk, getEvents, deleteEvent } = await import('../../lib/firestore');
            const school = learnJson.updated_profile;
            
            // 既存の学校イベントを削除（上書き）
            {
              console.log('[OCR Page] Deleting existing school events...');
              const allEvents = await getEvents();
              const schoolEvents = allEvents.filter((e: any) => e.source === 'aimo_school_timetable');
              console.log('[OCR Page] Found', schoolEvents.length, 'existing school events to delete');
              
              for (const event of schoolEvents) {
                await deleteEvent(event.id!);
              }
              console.log('[OCR Page] Deleted', schoolEvents.length, 'existing school events');
            }
          
          if (!school || !school.schedule || school.schedule.length === 0) {
            throw new Error('学校プロファイルが空です');
          }
          
          console.log('[OCR Page] Form submit - School profile:', school);
          console.log('[OCR Page] Form submit - Schedule length:', school.schedule.length);
          console.log('[OCR Page] Form submit - Timings length:', school.timings?.length || 0);
          
          // timings が不足している場合、schoolFormData.timings を使用
          if (!school.timings || school.timings.length === 0) {
            console.log('[OCR Page] Form submit - Using default timings from form');
            school.timings = schoolFormData.timings;
          }
          
          // 今日から次の長期休みまでの授業を生成
          const today = new Date();
          const endDate = new Date();
          
          // 次の長期休みまでの期間を計算
          const currentMonth = today.getMonth() + 1; // 1-12
          const currentYear = today.getFullYear();
          
          // 長期休みが設定されている場合はそれを使用、なければデフォルト値
          let targetEndDate: Date;
          
          try {
            if (currentMonth >= 1 && currentMonth <= 3) {
              // 1-3月: 春休みまで（3月末または設定値）
              if (school.vacations?.some((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'))) {
                const springVacation = school.vacations.find((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'));
                if (springVacation && springVacation.start) {
                  const [month, day] = springVacation.start.split('-').map(Number);
                  targetEndDate = new Date(currentYear, month - 1, day);
                } else {
                  targetEndDate = new Date(currentYear, 2, 31);
                }
              } else {
                targetEndDate = new Date(currentYear, 2, 31); // 3月31日
              }
            } else if (currentMonth >= 4 && currentMonth <= 7) {
              // 4-7月: 夏休みまで（7月末または設定値）
              if (school.vacations?.some((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'))) {
                const summerVacation = school.vacations.find((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'));
                if (summerVacation && summerVacation.start) {
                  const [month, day] = summerVacation.start.split('-').map(Number);
                  targetEndDate = new Date(currentYear, month - 1, day);
                } else {
                  targetEndDate = new Date(currentYear, 6, 31);
                }
              } else {
                targetEndDate = new Date(currentYear, 6, 31); // 7月31日
              }
            } else if (currentMonth >= 8 && currentMonth <= 12) {
              // 8-12月: 冬休みまで（正月終わりまたは設定値）
              if (school.vacations?.some((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'))) {
                const winterVacation = school.vacations.find((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'));
                if (winterVacation && winterVacation.start) {
                  const [month, day] = winterVacation.start.split('-').map(Number);
                  // 12月開始なら今年、01月開始なら来年
                  const targetYear = month === 12 ? currentYear : currentYear + 1;
                  targetEndDate = new Date(targetYear, month - 1, day);
                } else {
                  targetEndDate = new Date(currentYear, 11, 31);
                }
              } else {
                targetEndDate = new Date(currentYear, 11, 31); // 12月31日
              }
            } else {
              // フォールバック: 3ヶ月後
              targetEndDate = new Date(today);
              targetEndDate.setMonth(targetEndDate.getMonth() + 3);
            }
          } catch (e) {
            console.error('[OCR Page] Form submit - Failed to calculate target end date:', e);
            // フォールバック: 3ヶ月後
            targetEndDate = new Date(today);
            targetEndDate.setMonth(targetEndDate.getMonth() + 3);
          }
          
          endDate.setTime(targetEndDate.getTime());
          console.log('[OCR Page] Form submit - Generating classes from', today.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
          
          // 日本の祝日リスト（2025年）
          const japaneseHolidays2025 = [
            '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
            '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05',
            '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23',
            '2025-10-13', '2025-11-03', '2025-11-23', '2025-11-24'
          ];
          
          const generatedEvents = [];
          
          // 日付をイテレート
          for (let date = new Date(today); date <= endDate; date.setDate(date.getDate() + 1)) {
            // ローカル時間で日付文字列を生成（タイムゾーンのずれを防ぐ）
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            
            // 祝日チェック
            if (school.rules?.national_holidays_jp === 'OFF' && japaneseHolidays2025.includes(dateStr)) {
              continue;
            }
            
            // 長期休暇チェック
            const monthDay = `${month}-${day}`;
            const isVacation = school.vacations?.some((v: any) => monthDay >= v.start && monthDay <= v.end);
            if (isVacation) {
              continue;
            }
            
            // 曜日を取得（ローカル時間）
            const dayOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getDay()];
            
            // その曜日の授業を取得
            const classesForDay = school.schedule.filter((c: any) => c.day === dayOfWeek).sort((a: any, b: any) => a.period - b.period);
            
            if (classesForDay.length === 0) continue;
            
            // その日の全授業を1つのイベントにまとめる
            const timingsForDay = classesForDay.map((cls: any) => {
              const timing = school.timings?.find((t: any) => t.period === cls.period);
              if (!timing) return null;
              return { ...timing, subject: cls.subject, location: cls.location } as { start: string; end: string; period: number; subject: string; location?: string };
            }).filter((v: any): v is { start: string; end: string; period: number; subject: string; location?: string } => v !== null);
            
            if (timingsForDay.length === 0) {
              console.warn('[OCR Page] Form submit - No timings found for', dateStr);
              continue;
            }
            
            // 最初の授業の開始時刻と最後の授業の終了時刻を取得
            const firstClass = timingsForDay[0];
            const lastClass = timingsForDay[timingsForDay.length - 1];
            
            // JST（日本標準時）でISO文字列を作成
            const startTimeStr = `${dateStr}T${firstClass.start}:00+09:00`;
            const endTimeStr = `${dateStr}T${lastClass.end}:00+09:00`;
            
            const startTimeISO = new Date(startTimeStr).toISOString();
            const endTimeISO = new Date(endTimeStr).toISOString();
            
            // デバッグ用：最初のイベントのみログ出力
            if (generatedEvents.length === 0) {
              console.log('[OCR Page] Form submit - First event time conversion:');
              console.log('  Input times:', firstClass.start, '-', lastClass.end);
              console.log('  JST strings:', startTimeStr, '-', endTimeStr);
              console.log('  UTC ISO:', startTimeISO, '-', endTimeISO);
            }
            
            // 全授業の詳細を説明文に含める
            const classDetails = classesForDay.map((cls: any) => 
              `${cls.period}限: ${cls.subject}${cls.location ? ` (${cls.location})` : ''}`
            ).join('\n');
            
            generatedEvents.push({
              title: school.name || '学校',
              description: classDetails,
              start_time: startTimeISO,
              end_time: endTimeISO,
              category: 'work_study' as const,
              location: null,
              source: 'aimo_school_timetable' as const,
              external_id: `school_default_${dateStr}`,
              external_calendar_id: 'school_default',
              is_read_only: false,
              sync_status: null
            });
          }
          
          console.log('[OCR Page] Form submit - Generated', generatedEvents.length, 'class events (1 per day), adding to Firestore...');
          
          // Firestoreに一括保存
          await addEventsBulk(generatedEvents);
          
          console.log('[OCR Page] Form submit - Successfully added', generatedEvents.length, 'school events to calendar');
          
          // 学校プロファイルをユーザー設定に保存
          try {
            const settings = await getUserSettings();
            
            // scheduleをクリーニング（undefinedを除外）
            const rawSchedule = learnJson.updated_profile.schedule || [];
            const cleanSchedule = rawSchedule.map((c: any) => {
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
            
            const updatedSchoolProfile = {
              id: Date.now().toString(),
              name: learnJson.updated_profile.name || schoolFormData.schoolName,
              schedule: cleanSchedule,
              timings: learnJson.updated_profile.timings || schoolFormData.timings,
              rules: learnJson.updated_profile.rules || {
                national_holidays_jp: schoolFormData.holidayRule as 'OFF' | 'ON'
              },
              vacations: learnJson.updated_profile.vacations || []
            };
            
            // 既存のプロファイルを更新（最新のものを先頭に）
            const existingProfiles = settings.school_profiles || [];
            const updatedProfiles = [updatedSchoolProfile, ...existingProfiles.slice(0, 2)]; // 最大3件まで保存
            
            await updateUserSettings({
              school_profiles: updatedProfiles
            });
            
            console.log('[OCR Page] Form submit - Saved school profile to user settings');
          } catch (e) {
            console.error('[OCR Page] Form submit - Failed to save school profile:', e);
          }
        } catch (e) {
          console.error('[OCR Page] Form submit - Failed to generate school events:', e);
        }
        
        setSchoolLearningInProgress(false);
        setSchoolLearningSuccess(true);
        playSuccessSound();
      }
    } catch (e: any) {
      console.error('[OCR Page] School info error:', e);
      alert(e?.message ?? '追加情報の送信に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const uploadMultiple = async () => {
    if (files.length === 0) return;
    
    console.log('[OCR Page] uploadMultiple called with', files.length, 'files, mode:', mode);
    setLoading(true);
    setError(null);
    setSaved(false);
    setClarificationQuestions([]);
    localStorage.removeItem('ocr_preview');
    setEvents(null);
    setSchoolLearningSuccess(false);
    setSchoolLearningInProgress(false);
    setSchoolConversation([]);
    setSchoolContext(null);
    setSchoolOcrText('');
    setSchoolClasses([]);
    setSchoolFormData({
      schoolName: '',
      holidayRule: '',
      summerVacation: '',
      winterVacation: '',
      springVacation: '',
      timings: [
        { period: 1, start: '09:20', end: '10:10' },
        { period: 2, start: '10:20', end: '11:10' },
        { period: 3, start: '11:20', end: '12:10' },
        { period: 4, start: '13:10', end: '14:00' },
        { period: 5, start: '14:10', end: '15:00' },
        { period: 6, start: '15:10', end: '16:00' }
      ]
    });
    
    // 学校時間割モードの場合
    if (mode === 'school') {
      try {
        setLoadingStep({ 
          step: 1, 
          total: 2, 
          message: '時間割を解析中...', 
          progress: 20 
        });
        
        const targetFile = files[0];
        const form = new FormData();
        form.append('image', targetFile);
        form.append('mode', 'school');
        
        const ocrRes = await fetch('/api/ocr', { method: 'POST', body: form });
        if (!ocrRes.ok) {
          throw new Error('時間割の解析に失敗しました');
        }
        
        const ocrJson = await ocrRes.json();
        console.log('[OCR Page] School timetable OCR result:', ocrJson);
        
        if (!ocrJson.raw_ocr_text) {
          throw new Error('時間割のテキストを読み取れませんでした');
        }
        
        // OCR結果を保存（構造化データは /api/school/learn で生成される）
        setSchoolOcrText(ocrJson.raw_ocr_text);
        // schoolClasses は /api/school/learn の結果から取得するため、ここでは空のまま
        
        setLoadingStep({ 
          step: 2, 
          total: 2, 
          message: '時間割を学習中...', 
          progress: 70 
        });
        
        // 構造化されたクラスデータを整形
        let timetableInfo = `時間割の画像から読み取りました：\n\n`;
        
        if (ocrJson.timetable_classes && Array.isArray(ocrJson.timetable_classes) && ocrJson.timetable_classes.length > 0) {
          timetableInfo += `【解析された授業】\n`;
          const classesByDay: { [key: string]: any[] } = {};
          
          for (const cls of ocrJson.timetable_classes) {
            if (!classesByDay[cls.day_of_week]) {
              classesByDay[cls.day_of_week] = [];
            }
            classesByDay[cls.day_of_week].push(cls);
          }
          
          for (const day of ['月', '火', '水', '木', '金']) {
            if (classesByDay[day]) {
              timetableInfo += `\n${day}曜日:\n`;
              for (const cls of classesByDay[day].sort((a: any, b: any) => a.period - b.period)) {
                timetableInfo += `  ${cls.period}限 (${cls.start_time}-${cls.end_time}): ${cls.subject}`;
                if (cls.teacher) {
                  timetableInfo += ` [${cls.teacher}]`;
                }
                timetableInfo += '\n';
              }
            }
          }
        } else {
          timetableInfo += `【OCRテキスト】\n${ocrJson.raw_ocr_text}`;
        }
        
        // 学校プロファイルを学習
        const learnRes = await fetch('/api/school/learn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_input: timetableInfo,
            timetable_classes: ocrJson.timetable_classes || []
          })
        });
        
        if (!learnRes.ok) {
          throw new Error('時間割の学習に失敗しました');
        }
        
        const learnJson = await learnRes.json();
        console.log('[OCR Page] School learning result:', learnJson);
        
        setLoadingStep({ step: 2, total: 2, message: '完了しました！', progress: 100 });
        
        // 会話履歴を初期化
        const initialMessage = timetableInfo;
        setSchoolConversation([
          { role: 'user', content: initialMessage },
          { role: 'assistant', content: learnJson.reply || '' }
        ]);
        
        // コンテキストを保存
        setSchoolContext({
          learningProfile: learnJson.updated_profile,
          conversationHistory: [
            { role: 'user', content: initialMessage },
            { role: 'assistant', content: learnJson.reply || '' }
          ]
        });
        
        // 学習プロファイルから学校名を取得してフォームに設定
        if (learnJson.updated_profile?.name) {
          setSchoolFormData(prev => ({
            ...prev,
            schoolName: learnJson.updated_profile.name
          }));
        }
        
        // updated_profile.schedule から schoolClasses を生成
        if (learnJson.updated_profile && learnJson.updated_profile.schedule && learnJson.updated_profile.schedule.length > 0) {
          const schedule = learnJson.updated_profile.schedule;
          const timings = learnJson.updated_profile.timings || [];
          
          console.log('[OCR Page] Extracting classes from schedule:', schedule.length);
          
          // schedule を schoolClasses 形式に変換
          const extractedClasses = schedule.map((item: any) => {
            // day を day_of_week に変換
            const dayMap: {[key: string]: string} = {
              'MONDAY': '月',
              'TUESDAY': '火',
              'WEDNESDAY': '水',
              'THURSDAY': '木',
              'FRIDAY': '金'
            };
            
            // timings から該当する時限の時刻を取得
            const timing = timings.find((t: any) => t.period === item.period);
            
            return {
              day_of_week: dayMap[item.day] || item.day,
              period: item.period,
              start_time: timing?.start || '',
              end_time: timing?.end || '',
              subject: item.subject,
              teacher: item.location || '' // location に先生名が入っている
            };
          });
          
          console.log('[OCR Page] Extracted classes:', extractedClasses.length);
          setSchoolClasses(extractedClasses);
        } else {
          console.log('[OCR Page] No schedule in AI response, user will need to manually add classes');
          // AIが解析できなかった場合、ユーザーが手動で追加できるよう空配列を保持
          setSchoolClasses([]);
        }
        
        console.log('[OCR Page] learnJson.is_complete:', learnJson.is_complete);
        
        if (learnJson.is_complete) {
          console.log('[OCR Page] Learning complete, generating school events...');
          // 学校プロファイルが完成したので、授業予定を生成してカレンダーに登録
          try {
            // クライアント側のFirestoreを使って直接イベントを追加
            const { addEventsBulk, getEvents, deleteEvent } = await import('../../lib/firestore');
            const school = learnJson.updated_profile;
            
            // 既存の学校イベントを削除（上書き）
            {
              console.log('[OCR Page] Deleting existing school events...');
              const allEvents = await getEvents();
              const schoolEvents = allEvents.filter((e: any) => e.source === 'aimo_school_timetable');
              console.log('[OCR Page] Found', schoolEvents.length, 'existing school events to delete');
              
              for (const event of schoolEvents) {
                await deleteEvent(event.id!);
              }
              console.log('[OCR Page] Deleted', schoolEvents.length, 'existing school events');
            }
            
            if (!school || !school.schedule || school.schedule.length === 0) {
              throw new Error('学校プロファイルが空です');
            }
            
            console.log('[OCR Page] School profile:', school);
            console.log('[OCR Page] Schedule length:', school.schedule.length);
            console.log('[OCR Page] Timings length:', school.timings?.length || 0);
            
            // timings が不足している場合、schoolFormData.timings を使用
            if (!school.timings || school.timings.length === 0) {
              console.log('[OCR Page] Using default timings from form');
              school.timings = schoolFormData.timings;
            }
            
            // 今日から次の長期休みまでの授業を生成
            const today = new Date();
            const endDate = new Date();
            
            // 次の長期休みまでの期間を計算
            const currentMonth = today.getMonth() + 1; // 1-12
            const currentYear = today.getFullYear();
            
            // 長期休みが設定されている場合はそれを使用、なければデフォルト値
            let targetEndDate: Date;
            
            try {
              if (currentMonth >= 1 && currentMonth <= 3) {
                // 1-3月: 春休みまで（3月末または設定値）
                if (school.vacations?.some((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'))) {
                  const springVacation = school.vacations.find((v: any) => v?.start?.startsWith('03') || v?.start?.startsWith('04'));
                  if (springVacation && springVacation.start) {
                    const [month, day] = springVacation.start.split('-').map(Number);
                    targetEndDate = new Date(currentYear, month - 1, day);
                  } else {
                    targetEndDate = new Date(currentYear, 2, 31);
                  }
                } else {
                  targetEndDate = new Date(currentYear, 2, 31); // 3月31日
                }
              } else if (currentMonth >= 4 && currentMonth <= 7) {
                // 4-7月: 夏休みまで（7月末または設定値）
                if (school.vacations?.some((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'))) {
                  const summerVacation = school.vacations.find((v: any) => v?.start?.startsWith('07') || v?.start?.startsWith('08'));
                  if (summerVacation && summerVacation.start) {
                    const [month, day] = summerVacation.start.split('-').map(Number);
                    targetEndDate = new Date(currentYear, month - 1, day);
                  } else {
                    targetEndDate = new Date(currentYear, 6, 31);
                  }
                } else {
                  targetEndDate = new Date(currentYear, 6, 31); // 7月31日
                }
              } else if (currentMonth >= 8 && currentMonth <= 12) {
                // 8-12月: 冬休みまで（正月終わりまたは設定値）
                if (school.vacations?.some((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'))) {
                  const winterVacation = school.vacations.find((v: any) => v?.start?.startsWith('12') || v?.start?.startsWith('01'));
                  if (winterVacation && winterVacation.start) {
                    const [month, day] = winterVacation.start.split('-').map(Number);
                    // 12月開始なら今年、01月開始なら来年
                    const targetYear = month === 12 ? currentYear : currentYear + 1;
                    targetEndDate = new Date(targetYear, month - 1, day);
                  } else {
                    targetEndDate = new Date(currentYear, 11, 31);
                  }
                } else {
                  targetEndDate = new Date(currentYear, 11, 31); // 12月31日
                }
              } else {
                // フォールバック: 3ヶ月後
                targetEndDate = new Date(today);
                targetEndDate.setMonth(targetEndDate.getMonth() + 3);
              }
            } catch (e) {
              console.error('[OCR Page] Failed to calculate target end date:', e);
              // フォールバック: 3ヶ月後
              targetEndDate = new Date(today);
              targetEndDate.setMonth(targetEndDate.getMonth() + 3);
            }
            
            endDate.setTime(targetEndDate.getTime());
            console.log('[OCR Page] Generating classes from', today.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
            
            // 日本の祝日リスト（2025年）
            const japaneseHolidays2025 = [
              '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
              '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05',
              '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23',
              '2025-10-13', '2025-11-03', '2025-11-23', '2025-11-24'
            ];
            
            const generatedEvents = [];
            
            // 日付をイテレート
            let processedDays = 0;
            let skippedDays = 0;
            
            for (let date = new Date(today); date <= endDate; date.setDate(date.getDate() + 1)) {
              // ローカル時間で日付文字列を生成（タイムゾーンのずれを防ぐ）
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              const dateStr = `${year}-${month}-${day}`;
              
              // 祝日チェック
              if (school.rules?.national_holidays_jp === 'OFF' && japaneseHolidays2025.includes(dateStr)) {
                skippedDays++;
                continue;
              }
              
              // 長期休暇チェック
              const monthDay = `${month}-${day}`;
              const isVacation = school.vacations?.some((v: any) => monthDay >= v.start && monthDay <= v.end);
              if (isVacation) {
                skippedDays++;
                continue;
              }
              
              // 曜日を取得
              const dayOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getDay()];
              
              // その曜日の授業を取得
              const classesForDay = school.schedule.filter((c: any) => c.day === dayOfWeek).sort((a: any, b: any) => a.period - b.period);
              
              if (classesForDay.length === 0) continue;
              
              if (processedDays === 0) {
                console.log('[OCR Page] First day with classes:', dateStr, dayOfWeek, classesForDay.length, 'classes');
              }
              
              // その日の全授業を1つのイベントにまとめる
              const timingsForDay = classesForDay.map((cls: any) => {
                const timing = school.timings?.find((t: any) => t.period === cls.period);
                if (!timing) return null;
                return { ...timing, subject: cls.subject, location: cls.location } as { start: string; end: string; period: number; subject: string; location?: string };
              }).filter((v: any): v is { start: string; end: string; period: number; subject: string; location?: string } => v !== null);
              
              if (timingsForDay.length === 0) {
                console.warn('[OCR Page] No timings found for', dateStr);
                continue;
              }
              
              // 最初の授業の開始時刻と最後の授業の終了時刻を取得
              const firstClass = timingsForDay[0];
              const lastClass = timingsForDay[timingsForDay.length - 1];
              
              // JST（日本標準時）でISO文字列を作成
              const startTimeStr = `${dateStr}T${firstClass.start}:00+09:00`;
              const endTimeStr = `${dateStr}T${lastClass.end}:00+09:00`;
              
              const startTimeISO = new Date(startTimeStr).toISOString();
              const endTimeISO = new Date(endTimeStr).toISOString();
              
              // デバッグ用：最初のイベントのみログ出力
              if (processedDays === 0) {
                console.log('[OCR Page] First event time conversion:');
                console.log('  Input times:', firstClass.start, '-', lastClass.end);
                console.log('  JST strings:', startTimeStr, '-', endTimeStr);
                console.log('  UTC ISO:', startTimeISO, '-', endTimeISO);
              }
              
              // 全授業の詳細を説明文に含める
              const classDetails = classesForDay.map((cls: any) => 
                `${cls.period}限: ${cls.subject}${cls.location ? ` (${cls.location})` : ''}`
              ).join('\n');
              
              generatedEvents.push({
                title: school.name || '学校',
                description: classDetails,
                start_time: startTimeISO,
                end_time: endTimeISO,
                category: 'work_study' as const,
                location: null,
                source: 'aimo_school_timetable' as const,
                external_id: `school_default_${dateStr}`,
                external_calendar_id: 'school_default',
                is_read_only: false,
                sync_status: null
              });
              
              processedDays++;
            }
            
            console.log('[OCR Page] Generated', generatedEvents.length, 'class events, adding to Firestore...');
            console.log('[OCR Page] Processed days:', processedDays, 'Skipped days:', skippedDays);
            
            if (generatedEvents.length === 0) {
              console.error('[OCR Page] No events generated! Check:');
              console.error('[OCR Page] - school.timings:', school.timings);
              console.error('[OCR Page] - school.schedule sample:', school.schedule.slice(0, 3));
              throw new Error('授業イベントを生成できませんでした。時限の時刻設定を確認してください。');
            }
            
            // Firestoreに一括保存
            await addEventsBulk(generatedEvents);
            
            console.log('[OCR Page] Successfully added', generatedEvents.length, 'school events to calendar');
            
            // 学校プロファイルをユーザー設定に保存
            try {
              const settings = await getUserSettings();
              
              // scheduleをクリーニング（undefinedを除外）
              const rawSchedule = learnJson.updated_profile.schedule || [];
              const cleanSchedule = rawSchedule.map((c: any) => {
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
              
              const updatedSchoolProfile = {
                id: Date.now().toString(),
                name: learnJson.updated_profile.name || schoolFormData.schoolName,
                schedule: cleanSchedule,
                timings: learnJson.updated_profile.timings || schoolFormData.timings,
                rules: learnJson.updated_profile.rules || {
                  national_holidays_jp: schoolFormData.holidayRule as 'OFF' | 'ON'
                },
                vacations: learnJson.updated_profile.vacations || []
              };
              
              // 既存のプロファイルを更新（最新のものを先頭に）
              const existingProfiles = settings.school_profiles || [];
              const updatedProfiles = [updatedSchoolProfile, ...existingProfiles.slice(0, 2)]; // 最大3件まで保存
              
              await updateUserSettings({
                school_profiles: updatedProfiles
              });
              
              console.log('[OCR Page] Saved school profile to user settings');
            } catch (e) {
              console.error('[OCR Page] Failed to save school profile:', e);
            }
          } catch (e) {
            console.error('[OCR Page] Failed to generate school events:', e);
          }
          
          setSchoolLearningSuccess(true);
          playSuccessSound();
        } else {
          console.log('[OCR Page] Learning not complete, showing form for additional info');
          setSchoolLearningInProgress(true);
        }
        
      } catch (e: any) {
        console.error('[OCR Page] School mode error:', e);
        setError(e?.message ?? '時間割の登録に失敗しました');
      } finally {
        setLoading(false);
        setLoadingStep(null);
      }
      return;
    }
    
    // シフトモードの処理
    const allEvents: FirestoreEvent[] = [];
    let allRawOcrText = '';
    
    try {
      for (let i = 0; i < files.length; i++) {
        setCurrentFileIndex(i);
        setLoadingStep({ 
          step: 1, 
          total: 3, 
          message: `画像 ${i + 1}/${files.length} を解析中...`, 
          progress: Math.round((i / files.length) * 100) 
        });
        
        const targetFile = files[i];
        console.log(`[OCR Page] Processing file ${i + 1}/${files.length}:`, targetFile.name);
        
        const form = new FormData();
        form.append('image', targetFile);
        form.append('type', 'schedule_table');
        const settings = await getUserSettings();
        if (settings.shift_search_name) {
          form.append('shift_name', settings.shift_search_name);
        }
        
        const res = await fetch('/api/ocr', { method: 'POST', body: form });
        if (!res.ok) {
          const errorText = await res.text();
          console.error(`[OCR Page] API Error for file ${i + 1}:`, res.status, errorText);
          throw new Error(`画像 ${i + 1} の解析に失敗しました`);
        }
        
        const json = await res.json();
        console.log(`[OCR Page] File ${i + 1} response:`, json);
        
        // OCRテキストを保存
        if (json.raw_ocr_text) {
          allRawOcrText += (allRawOcrText ? '\n---\n' : '') + json.raw_ocr_text;
        }
        
        // イベントをマージ
        const extracted = json.extracted_events ?? [];
        if (Array.isArray(extracted) && extracted.length > 0) {
          const mapped = extracted.map((e: any) => ({
            title: e.title || '（タイトル未設定）',
            start_time: e.start_time,
            end_time: e.end_time ?? null,
            category: (e.category as any) ?? 'other'
          }));
          allEvents.push(...mapped);
          console.log(`[OCR Page] File ${i + 1}: Extracted ${mapped.length} events`);
        }
      }
      
      // すべてのイベントを設定
      setRawOcrText(allRawOcrText);
      setEvents(allEvents);
      setLoadingStep({ step: 3, total: 3, message: '完了しました！', progress: 100 });
      playSuccessSound();
      await new Promise(resolve => setTimeout(resolve, 800));
      
      console.log('[OCR Page] All files processed. Total events:', allEvents.length);
      
      // バイト先確認
      const settings = await getUserSettings();
      const workplaceProfiles = settings.shift_workplaces || [];
      if (workplaceProfiles.length === 0 && settings.shift_search_name) {
        workplaceProfiles.push({
          id: 'default',
          name: 'バイト先',
          search_name: settings.shift_search_name,
          keywords: []
        });
      }
      
      setExistingWorkplaces(workplaceProfiles);
      
      if (workplaceProfiles.length === 0) {
        setIsNewWorkplace(true);
        setAskWorkplaceName(true);
      } else {
        setAskWorkplaceName(true);
      }
    } catch (e: any) {
      console.error('[OCR Page] Upload error:', e);
      setError(e?.message ?? 'アップロードに失敗しました');
      setEvents([]);
    } finally {
      setLoading(false);
      setLoadingStep(null);
      setCurrentFileIndex(0);
    }
  };

  const upload = async (clarification?: string) => {
    console.log('[OCR Page] upload function called, clarification:', clarification);
    const targetFile = currentFile || file;
    console.log('[OCR Page] targetFile:', targetFile?.name);
    if (!targetFile) {
      console.warn('[OCR Page] No file selected');
      return;
    }
    console.log('[OCR Page] Starting upload process...');
    setLoading(true);
    setLoadingStep({ step: 1, total: 3, message: '解析を開始します...', progress: 0 });
    setError(null);
    setSaved(false);
    setClarificationQuestions([]);
    // localStorageをクリア（古いデータを防ぐため）
    localStorage.removeItem('ocr_preview');
    setEvents(null); // 古いデータをクリア
    console.log('[OCR Page] Events cleared, localStorage cleared');
    
    // ステップ1の表示を少し遅延
    await new Promise(resolve => setTimeout(resolve, 500));
    setLoadingStep({ step: 1, total: 3, message: '画像から文字を読み取っています (OCR)', progress: 10 });
    
    try {
      const form = new FormData();
      form.append('image', targetFile);
      form.append('type', 'schedule_table');
      const settings = await getUserSettings();
      if (settings.shift_search_name) {
        form.append('shift_name', settings.shift_search_name);
      }
      if (clarification) {
        form.append('clarification_answer', clarification);
      }
      console.log('[OCR Page] Sending request to /api/ocr...');
      
      // APIコール開始 - ステップ2に進む
      const fetchPromise = fetch('/api/ocr', { method: 'POST', body: form });
      
      // 進捗アニメーション
      const progressInterval = setInterval(() => {
        setLoadingStep((prev) => {
          if (!prev) return null;
          const newProgress = Math.min(prev.progress + 2, 90); // 最大90%まで
          return { ...prev, progress: newProgress };
        });
      }, 500);
      
      // 5秒後にステップ2のメッセージを表示
      setTimeout(() => {
        if (loading) {
          setLoadingStep({ step: 2, total: 3, message: 'AIがシフト表の意味を解釈しています', progress: 40 });
        }
      }, 5000);
      
      // 15秒後にステップ3のメッセージを表示
      setTimeout(() => {
        if (loading) {
          setLoadingStep({ step: 3, total: 3, message: 'スケジュールを整形しています', progress: 70 });
        }
      }, 15000);
      
      const res = await fetchPromise;
      clearInterval(progressInterval); // 進捗アニメーション停止
      console.log('[OCR Page] Response status:', res.status, res.statusText);
      
      if (!res.ok) {
        const errorText = await res.text();
        console.error('[OCR Page] API Error:', res.status, errorText);
        clearInterval(progressInterval);
        throw new Error(`API error: ${res.status} ${errorText}`);
      }
      
      // 完了直前
      setLoadingStep({ step: 3, total: 3, message: '完了しました！', progress: 100 });
      playSuccessSound(); // 効果音を再生
      await new Promise(resolve => setTimeout(resolve, 800)); // 完了表示を少し見せる
      
      const json = await res.json();
      
      console.log('[OCR Page] API Response (full):', JSON.stringify(json, null, 2));
      console.log('[OCR Page] API Response keys:', Object.keys(json));
      console.log('[OCR Page] extracted_events type:', typeof json.extracted_events);
      console.log('[OCR Page] extracted_events value:', json.extracted_events);
      console.log('[OCR Page] extracted_events isArray:', Array.isArray(json.extracted_events));
      console.log('[OCR Page] Extracted events count:', json.extracted_events?.length ?? 'undefined/null');
      
      // OCRテキストを保存（自動学習用）
      if (json.raw_ocr_text) {
        setRawOcrText(json.raw_ocr_text);
        console.log('[OCR Page] Saved raw OCR text for auto-learning');
      }
      
      // 確認質問が必要な場合
      if (json.clarification_needed && json.clarification_questions) {
        setClarificationQuestions(json.clarification_questions);
        setCurrentFile(targetFile); // ファイルを保存
        setEvents([]);
        } else {
          const extracted = json.extracted_events ?? [];
          console.log('[OCR Page] Raw extracted_events from API:', extracted);
          console.log('[OCR Page] extracted_events length:', extracted.length);
          
          if (!Array.isArray(extracted)) {
            console.error('[OCR Page] extracted_events is not an array:', typeof extracted, extracted);
            setEvents([]);
          } else if (extracted.length === 0) {
            console.warn('[OCR Page] No events extracted from API response');
            setEvents([]);
          } else {
            const mappedEvents = extracted.map((e: any) => {
              const mapped = {
                title: e.title || '（タイトル未設定）',
                start_time: e.start_time,
                end_time: e.end_time ?? null,
                category: (e.category as any) ?? 'other'
              };
              console.log('[OCR Page] Mapping event:', e, '->', mapped);
              return mapped;
            });
                  console.log('[OCR Page] All mapped events:', JSON.stringify(mappedEvents, null, 2));
                  console.log('[OCR Page] Setting events state with', mappedEvents.length, 'events');
                  // 明示的にsetEventsを呼び出す
                  setEvents(mappedEvents);
                  console.log('[OCR Page] Events state set. Waiting for re-render...');
                  
                  // OCR完了後、常にバイト先を確認
                  const settings = await getUserSettings();
                  const workplaceProfiles = settings.shift_workplaces || [];
                  
                  // 後方互換：shift_search_nameがあれば自動変換
                  if (workplaceProfiles.length === 0 && settings.shift_search_name) {
                    workplaceProfiles.push({
                      id: 'default',
                      name: 'バイト先',
                      search_name: settings.shift_search_name,
                      keywords: []
                    });
                  }
                  
                  console.log('[OCR Page] Checking workplace profiles...');
                  console.log('[OCR Page] Workplaces:', workplaceProfiles);
                  
                  setExistingWorkplaces(workplaceProfiles);
                  
                  if (workplaceProfiles.length === 0) {
                    // バイト先が1つもない → 新規作成
                    console.log('[OCR Page] No workplaces. Asking for new workplace name...');
                    setIsNewWorkplace(true);
                    setAskWorkplaceName(true);
                  } else {
                    // バイト先が存在 → どのバイト先か選択させる
                    console.log('[OCR Page] Found', workplaceProfiles.length, 'workplaces. Asking user to select...');
                    setAskWorkplaceName(true);
                  }
                }
                setCurrentFile(null); // 解析完了したらファイルをクリア
              }
    } catch (e: any) {
      console.error('[OCR Page] Upload error:', e);
      console.error('[OCR Page] Error stack:', e?.stack);
      console.error('[OCR Page] Error message:', e?.message);
      setError(e?.message ?? 'アップロードに失敗しました');
      setEvents([]); // エラー時も空配列を設定
    } finally {
      setLoading(false);
      setLoadingStep(null);
      console.log('[OCR Page] Upload process finished');
    }
  };

  const handleClarificationAnswer = (answer: string) => {
    setClarificationAnswer(answer);
    upload(answer);
  };

  const updateEvent = (idx: number, patch: Partial<FirestoreEvent>) => {
    if (!events) return;
    const next = [...events];
    next[idx] = { ...next[idx], ...patch } as FirestoreEvent;
    setEvents(next);
  };

  // 日付範囲を計算する関数
  const calculateDateRange = (evs: FirestoreEvent[]) => {
    if (evs.length === 0) return null;
    const dates = evs.map((e) => e.start_time).filter(Boolean).sort();
    if (dates.length === 0) return null;
    return {
      start: dates[0],
      end: dates[dates.length - 1]
    };
  };

  // eventsが変更されたら日付範囲を計算
  useEffect(() => {
    if (events && events.length > 0) {
      const range = calculateDateRange(events);
      setDateRange(range);
    } else {
      setDateRange(null);
    }
  }, [events]);

  const saveAll = async () => {
    if (!events || events.length === 0) return;
    
    // バイト先が選択されていない場合は警告
    if (askWorkplaceName) {
      if (isNewWorkplace && !workplaceNameInput.trim()) {
        alert('バイト先名を入力してください。');
        return;
      }
      if (!isNewWorkplace && !selectedWorkplaceId) {
        alert('バイト先を選択してください。または「＋ 新しいバイト先」から登録してください。');
        return;
      }
      
      // 新しいバイト先の場合、まず保存
      if (isNewWorkplace && workplaceNameInput.trim()) {
        await saveWorkplaceProfile();
      }
      
      // 既存のバイト先の場合、キーワードを更新
      if (!isNewWorkplace && selectedWorkplaceId) {
        const selected = existingWorkplaces.find(w => w.id === selectedWorkplaceId);
        if (selected) {
          await updateWorkplaceKeywords(selected);
        }
      }
    }
    
    // 上書き確認ダイアログを表示
    setShowOverwriteDialog(true);
  };
  
  const saveWorkplaceProfile = async () => {
    if (!workplaceNameInput.trim() || !rawOcrText) return;
    
    console.log('[OCR] Creating new workplace profile:', workplaceNameInput);
    try {
      const settings = await getUserSettings();
      const keywords = extractKeywords(rawOcrText);
      console.log('[OCR] Auto-extracted keywords:', keywords);
      
      const newWorkplace: WorkplaceProfile = {
        id: Date.now().toString(),
        name: workplaceNameInput.trim(),
        search_name: shiftSearchNameForDisplay || 'あなた',
        keywords: keywords
      };
      
      const existingWorkplacesList = settings.shift_workplaces || [];
      const updatedWorkplaces = [...existingWorkplacesList, newWorkplace];
      
      await updateUserSettings({ 
        shift_workplaces: updatedWorkplaces,
        shift_search_name: settings.shift_search_name || shiftSearchNameForDisplay || null
      });
      
      console.log('[OCR] Workplace profile created:', newWorkplace);
      setAskWorkplaceName(false); // 質問を非表示
    } catch (e: any) {
      console.error('[OCR] Failed to save workplace:', e);
    }
  };
  
  const updateWorkplaceKeywords = async (workplace: WorkplaceProfile, silent = false) => {
    if (!rawOcrText) return;
    
    console.log('[OCR] Updating keywords for workplace:', workplace.name);
    try {
      const settings = await getUserSettings();
      const newKeywords = extractKeywords(rawOcrText);
      console.log('[OCR] New keywords extracted:', newKeywords);
      
      const workplaces = settings.shift_workplaces || [];
      const targetIndex = workplaces.findIndex(w => w.id === workplace.id);
      
      if (targetIndex !== -1) {
        const existingKeywords = workplaces[targetIndex].keywords || [];
        const mergedKeywords = [...new Set([...existingKeywords, ...newKeywords])];
        
        workplaces[targetIndex].keywords = mergedKeywords;
        
        await updateUserSettings({ shift_workplaces: workplaces });
        console.log('[OCR] Keywords updated:', mergedKeywords);
        
        if (!silent && newKeywords.length > 0) {
          alert(`[完了] 「${workplace.name}」の特徴を学習しました！\n\n追加されたキーワード: ${newKeywords.join(', ')}\n\n次回から自動判別の精度が向上します。`);
        }
      }
    } catch (e: any) {
      console.error('[OCR] Failed to update keywords:', e);
    }
  };

  const confirmOverwrite = async () => {
    if (!events || events.length === 0 || !dateRange) return;
    console.log('[OCR] Starting overwrite process...');
    console.log('[OCR] Events to save:', events);
    console.log('[OCR] Date range:', dateRange);
    console.log('[OCR] Selected workplace ID:', selectedWorkplaceId);
    console.log('[OCR] Selected workplace name:', selectedWorkplaceName);
    
    setLoading(true);
    setError(null);
    setShowOverwriteDialog(false);
    try {
      // 0. バイト先情報を取得
      const workplace = existingWorkplaces.find(w => w.id === selectedWorkplaceId);
      
      if (!workplace) {
        alert('バイト先が選択されていません');
        setLoading(false);
        return;
      }
      
      // 0-1. イベントのタイトルを選択されたバイト先名に更新
      const workplaceName = selectedWorkplaceName || workplace.name || 'バイト';
      
      console.log('[OCR] Using workplace name:', workplaceName, '(from:', selectedWorkplaceName || 'workplace.name', ')');
      
      // 0-2. バイト先の給与プロファイルを取得
      const hasSalaryProfile = workplace?.salary_profile?.base_hourly_rate;
      
      // 0-3. 給与計算を実行（給与プロファイルがある場合）
      const eventsWithSalary = events.map(e => {
        const baseEvent = {
        ...e,
          title: workplaceName,
          workplace_id: selectedWorkplaceId || null
        };
        
        // 給与計算（開始時刻と終了時刻がある場合のみ）
        if (hasSalaryProfile && e.start_time && e.end_time && workplace?.salary_profile) {
          try {
            const salaryResult = calculateSalary(
              {
                start_time: e.start_time,
                end_time: e.end_time,
                workplace_id: selectedWorkplaceId || ''
              },
              workplace.salary_profile
            );
            
            return {
              ...baseEvent,
              estimated_salary: salaryResult.total_pay,
              salary_breakdown: salaryResult.breakdown_details
            };
          } catch (err) {
            console.error('[OCR] Salary calculation error:', err);
            return baseEvent;
          }
        }
        
        return baseEvent;
      });
      
      console.log('[OCR] Updated events with workplace name and salary:', eventsWithSalary);
      
      // 1. 既存の全予定を取得
      const existingEvents = await getEvents();
      console.log('[OCR] Existing events count:', existingEvents.length);
      
      // 2. 期間内の同じバイト先の予定を抽出（「バイト」または選択されたバイト先名）
      console.log('[OCR] Filtering existing events...');
      console.log('[OCR] Date range for filtering:', dateRange);
      
      const eventsToDelete = existingEvents.filter((e) => {
        const titleMatch = e.title === 'バイト' || e.title === workplaceName || e.title?.includes('バイト');
        console.log('[OCR] Checking event:', { 
          id: e.id, 
          title: e.title, 
          start: e.start_time,
          titleMatch,
          hasStartTime: !!e.start_time,
          inRange: e.start_time ? (e.start_time >= dateRange.start && e.start_time <= dateRange.end) : false
        });
        
        if (!titleMatch) {
          console.log('[OCR] - Title does not match');
          return false;
        }
        if (!e.start_time) {
          console.log('[OCR] - No start_time');
          return false;
        }
        // 期間内かチェック
        const inRange = e.start_time >= dateRange.start && e.start_time <= dateRange.end;
        console.log('[OCR] - In range check:', e.start_time, '>=', dateRange.start, '&&', '<=', dateRange.end, '=', inRange);
        return inRange;
      });
      
      console.log('[OCR] Deleting', eventsToDelete.length, 'existing events in range');
      console.log('[OCR] Events to delete:', eventsToDelete.map(e => ({ id: e.id, title: e.title, start: e.start_time })));
      
      // 3. 該当する予定を削除
      for (const ev of eventsToDelete) {
        if (ev.id) {
          console.log('[OCR] Deleting event:', ev.id, ev.title);
          await deleteEvent(ev.id);
        }
      }
      
      console.log('[OCR] Deletion complete. Starting bulk add...');
      
      // 4. 新規予定を一括登録（バイト先名と給与が付いたイベント）
      await addEventsBulk(eventsWithSalary);
      console.log('[OCR] Bulk add complete!');
      
      setSaved(true);
      playSuccessSound(); // 登録完了の効果音
      setShowSuccessAnimation(true);
      setTimeout(() => setShowSuccessAnimation(false), 2000); // 2秒後に消す
    } catch (e: any) {
      console.error('[OCR] Save error:', e);
      console.error('[OCR] Error stack:', e?.stack);
      setError(e?.message ?? '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const cancelOverwrite = () => {
    setShowOverwriteDialog(false);
  };

  // 効果音を再生する関数
  const playSuccessSound = () => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      // チーン♪の音（2つの音を連続で鳴らす）
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(1000, audioContext.currentTime + 0.1);
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (e) {
      console.warn('[OCR] Could not play sound:', e);
    }
  };

  const sortedEvents = useMemo(() => {
    if (!events) {
      console.log('[OCR Page] sortedEvents: events is null/undefined');
      return [];
    }
    console.log('[OCR Page] sortedEvents: processing', events.length, 'events, sortBy:', sortBy);
    const sorted = [...events];
    if (sortBy === 'date') {
      sorted.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    }
    console.log('[OCR Page] sortedEvents: result:', sorted.map(e => `${e.title} (${e.start_time})`));
    return sorted;
  }, [events, sortBy]);

  const categoryLabel: Record<string, string> = {
    work_study: '仕事・勉強',
    life_chores: '生活・雑務',
    leisure: '余暇',
    other: 'その他'
  };

  // ローディング状態の判定
  const showLoadingPlaceholder = loading && events === null && loadingStep === null;

  return (
    <div className="container">
      <h2 style={{ marginBottom: 16 }}>OCRで予定を一括登録</h2>
      
      {/* モード切り替え */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          className={mode === 'shift' ? 'btn' : 'btn secondary'}
          onClick={() => {
            setMode('shift');
            setEvents(null);
            setError(null);
            setFiles([]);
            setFile(null);
            setSchoolLearningSuccess(false);
            setSchoolLearningInProgress(false);
            setSchoolConversation([]);
            setSchoolContext(null);
            setSchoolOcrText('');
            setSchoolClasses([]);
            setSchoolFormData({
              schoolName: '',
              holidayRule: '',
              summerVacation: '',
              winterVacation: '',
              springVacation: '',
              timings: [
                { period: 1, start: '09:20', end: '10:10' },
                { period: 2, start: '10:20', end: '11:10' },
                { period: 3, start: '11:20', end: '12:10' },
                { period: 4, start: '13:10', end: '14:00' },
                { period: 5, start: '14:10', end: '15:00' },
                { period: 6, start: '15:10', end: '16:00' }
              ]
            });
          }}
          style={{ flex: 1 }}
        >
          シフト登録
        </button>
        <button
          className={mode === 'school' ? 'btn' : 'btn secondary'}
          onClick={() => {
            setMode('school');
            setEvents(null);
            setError(null);
            setFiles([]);
            setFile(null);
            setSaved(false);
            setAskWorkplaceName(false);
            setSelectedWorkplaceId('');
            setIsNewWorkplace(false);
          }}
          style={{ flex: 1 }}
        >
          学校時間割登録
        </button>
      </div>

      {mode === 'school' && (
        <div className="card" style={{ background: '#eff6ff', borderColor: '#3b82f6', marginBottom: 16, padding: 14 }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 15, color: '#1e40af' }}>
            時間割表の撮影のコツ
          </h4>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#1e40af', lineHeight: 1.6 }}>
            <li>明るい場所で撮影してください</li>
            <li>時間割表全体が画面に収まるように撮影してください</li>
            <li>文字がぼやけないように、ピントを合わせてください</li>
            <li>影や反射が入らないように注意してください</li>
          </ul>
          <p style={{ margin: '10px 0 0 0', fontSize: 12, color: '#6b7280' }}>
            読み取れない部分は、後ほどAIが質問しますので、手動で入力できます。
          </p>
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.pdf"
          multiple={mode === 'shift'}
          onChange={(e) => {
            const fileList = Array.from(e.target.files || []);
            if (fileList.length > 0) {
              setFiles(fileList);
              setFile(fileList[0]); // 後方互換
              setCurrentFile(fileList[0]);
              setClarificationQuestions([]);  // 新しいファイル選択時は確認をリセット
              console.log('[OCR Page] Selected', fileList.length, 'files');
            }
          }}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={() => uploadMultiple()} disabled={files.length === 0 || loading}>
          {loading 
            ? mode === 'school' ? '時間割を登録中...' : `解析中... (${currentFileIndex + 1}/${files.length})` 
            : mode === 'school' 
              ? '時間割を登録' 
              : files.length > 1 ? `${files.length}枚を解析` : '解析する'}
        </button>
      </div>

      {clarificationQuestions.length > 0 && (
        <div className="card" style={{ marginBottom: 24, background: '#fef3c7', borderColor: '#f59e0b' }}>
          <h3 style={{ marginTop: 0 }}>確認が必要です</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
            シフト表に「{shiftSearchNameForDisplay || '同じ名前'}」という名前が複数見つかりました。
            <br />
            どちらのシフトを抽出しますか？
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {clarificationQuestions.map((q, i) => (
              <button
                key={i}
                className="btn"
                onClick={() => handleClarificationAnswer(q)}
                disabled={loading}
                style={{ textAlign: 'left', justifyContent: 'flex-start' }}
              >
                {q}
              </button>
            ))}
            <button
              className="btn secondary"
              onClick={() => {
                setClarificationQuestions([]);
                setCurrentFile(null);
              }}
              style={{ marginTop: 8 }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 学校設定編集ボタン */}
      {mode === 'school' && schoolFormData.schoolName && !schoolLearningInProgress && (
        <div className="card" style={{ marginBottom: 24, background: '#f0f9ff', borderColor: '#0ea5e9' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h4 style={{ margin: 0, fontSize: 14, color: '#0c4a6e' }}>
                登録済み学校: {schoolFormData.schoolName}
              </h4>
              <p style={{ fontSize: 12, color: '#0369a1', margin: '4px 0 0 0' }}>
                長期休み期間や祝日ルールを変更できます
              </p>
            </div>
            <button
              className="btn"
              onClick={() => setShowSchoolSettings(!showSchoolSettings)}
              style={{ background: '#0284c7', fontSize: 13, padding: '6px 16px' }}
            >
              {showSchoolSettings ? '閉じる' : '設定を編集'}
            </button>
          </div>
        </div>
      )}

      {/* 学校設定編集フォーム */}
      {showSchoolSettings && (
        <div className="card" style={{ marginBottom: 24, background: 'white', borderColor: '#0ea5e9' }}>
          <h3 style={{ marginTop: 0, color: '#0c4a6e' }}>学校設定を編集</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 学校名 */}
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                学校名（必須）
              </label>
              <input
                type="text"
                className="input"
                value={schoolFormData.schoolName}
                onChange={(e) => setSchoolFormData({ ...schoolFormData, schoolName: e.target.value })}
                placeholder="例: 慶應義塾大学 環境情報学部"
                style={{ width: '100%' }}
              />
            </div>
            
            {/* 祝日ルール */}
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                祝日の授業
              </label>
              <select
                className="input"
                value={schoolFormData.holidayRule}
                onChange={(e) => setSchoolFormData({ ...schoolFormData, holidayRule: e.target.value })}
                style={{ width: '100%' }}
              >
                <option value="">選択してください</option>
                <option value="OFF">休講</option>
                <option value="ON">通常通り</option>
              </select>
            </div>
            
            {/* 夏休み */}
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                夏休み期間（任意）
              </label>
              <input
                type="text"
                className="input"
                value={schoolFormData.summerVacation}
                onChange={(e) => setSchoolFormData({ ...schoolFormData, summerVacation: e.target.value })}
                placeholder="例: 8月1日 ～ 9月20日"
                style={{ width: '100%' }}
              />
            </div>
            
            {/* 冬休み */}
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                冬休み期間（任意）
              </label>
              <input
                type="text"
                className="input"
                value={schoolFormData.winterVacation}
                onChange={(e) => setSchoolFormData({ ...schoolFormData, winterVacation: e.target.value })}
                placeholder="例: 12月25日 ～ 1月7日"
                style={{ width: '100%' }}
              />
            </div>
            
            {/* 春休み */}
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                春休み期間（任意）
              </label>
              <input
                type="text"
                className="input"
                value={schoolFormData.springVacation}
                onChange={(e) => setSchoolFormData({ ...schoolFormData, springVacation: e.target.value })}
                placeholder="例: 2月15日 ～ 4月5日"
                style={{ width: '100%' }}
              />
            </div>
            
            {/* 保存ボタン */}
            <button
              className="btn"
              onClick={updateSchoolSettings}
              disabled={loading || !schoolFormData.schoolName.trim()}
              style={{ marginTop: 8 }}
            >
              {loading ? '更新中...' : '設定を保存して予定を再生成'}
            </button>
            
            <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0 0' }}>
              ※ 設定を変更すると、既存の授業予定が削除され、新しい期間で再生成されます。
            </p>
          </div>
        </div>
      )}

      {error ? (
        <div className="card" style={{ 
          background: '#fee2e2', 
          borderColor: '#b91c1c', 
          marginBottom: 24,
          padding: 24
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ 
              fontSize: 20, 
              fontWeight: 700, 
              color: '#b91c1c',
              width: 24,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              border: '2px solid #b91c1c'
            }}>!</div>
            <div style={{ flex: 1 }}>
              <h4 style={{ marginTop: 0, marginBottom: 8, color: '#b91c1c' }}>解析に失敗しました</h4>
              <p style={{ color: '#991b1b', marginBottom: 16, fontSize: 14 }}>{error}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  className="btn" 
                  onClick={() => {
                    setError(null);
                    fileRef.current?.click();
                  }}
                  style={{ background: '#b91c1c', fontSize: 14, padding: '8px 16px' }}
                >
                  もう一度撮り直す
                </button>
                <button 
                  className="btn secondary" 
                  onClick={() => setError(null)}
                  style={{ fontSize: 14, padding: '8px 16px' }}
                >
                  閉じる
                </button>
              </div>
              <div style={{ 
                marginTop: 12, 
                fontSize: 13, 
                color: '#991b1b',
                padding: 12,
                background: '#fff',
                borderRadius: 8,
                border: '1px solid #fecaca'
              }}>
                <strong>ヒント:</strong> 画像が明るく、文字がはっきり見えるように撮影してください
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 段階的ローディングUI */}
      {loadingStep !== null ? (
        <div className="card" style={{ 
          marginBottom: 24, 
          background: '#eff6ff', 
          borderColor: '#3b82f6',
          padding: 32,
          textAlign: 'center'
        }}>
          {loadingStep.progress < 100 ? (
            <div className="spinner" style={{ marginBottom: 16 }} />
          ) : (
            <div style={{ 
              fontSize: 48, 
              marginBottom: 16,
              animation: 'bounce 0.6s ease-out'
            }}>
              OK
            </div>
          )}
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
            {loadingStep.step}/{loadingStep.total}
          </div>
          <div style={{ fontSize: 16, color: 'var(--text-secondary)', marginBottom: 16 }}>
            {loadingStep.message}
          </div>
          
          {/* 進捗バー */}
          <div style={{ 
            width: '100%', 
            maxWidth: 400, 
            height: 8, 
            background: '#e5e7eb',
            borderRadius: 4,
            overflow: 'hidden',
            margin: '0 auto 8px'
          }}>
            <div style={{
              width: `${loadingStep.progress}%`,
              height: '100%',
              background: loadingStep.progress === 100 ? '#16a34a' : '#3b82f6',
              transition: 'width 0.3s ease-out, background 0.3s ease-out'
            }} />
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {loadingStep.progress}%
          </div>
          
          {loadingStep.step === 2 && loadingStep.progress < 100 && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              （交点や「公休」ルールを思い出しています...）
            </div>
          )}
        </div>
      ) : null}

      {showLoadingPlaceholder ? (
        <div style={{ display: 'grid', gap: 16 }}>
          {[1, 2, 3].map((i: number) => (
            <div key={i} className="card" style={{ height: 120, background: '#f3f4f6', borderColor: '#e5e7eb' }} />
          ))}
        </div>
      ) : null}

      {events !== null && events.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>
          <IconDocument />
          <div style={{ marginTop: 12 }}>抽出結果がありません</div>
        </div>
      ) : null}

      {askWorkplaceName && events && events.length > 0 && mode === 'shift' && (
        <div className="card" style={{ marginBottom: 24, background: '#eff6ff', borderColor: '#3b82f6' }}>
          <h3 style={{ marginTop: 0, fontSize: 18 }}>このシフトはどのバイト先のものですか？</h3>
          
          {existingWorkplaces.length > 0 && !isNewWorkplace ? (
            // 既存のバイト先から選択
            <>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14 }}>
                登録済みのバイト先から選択するか、新しいバイト先として登録してください。
              </p>
              <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                {existingWorkplaces.map((wp) => (
                  <button
                    key={wp.id}
                    className={selectedWorkplaceId === wp.id ? 'btn' : 'btn secondary'}
                    onClick={() => setSelectedWorkplaceId(wp.id)}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: 8,
                      justifyContent: 'flex-start',
                      width: '100%',
                      padding: 12
                    }}
                  >
                    {selectedWorkplaceId === wp.id ? '[選択]' : '○'} {wp.name}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  className="btn" 
                  onClick={async () => {
                    if (selectedWorkplaceId) {
                      const selected = existingWorkplaces.find(w => w.id === selectedWorkplaceId);
                      if (selected) {
                        console.log('[OCR] User selected existing workplace:', selected.name);
                        setSelectedWorkplaceName(selected.name); // バイト先名を保存
                        
                        // イベントのタイトルをバイト先名で更新（プレビュー用）
                        if (events && events.length > 0) {
                          const updatedEvents = events.map(e => ({
                            ...e,
                            title: selected.name
                          }));
                          setEvents(updatedEvents);
                          console.log('[OCR] Updated event titles to:', selected.name);
                        }
                        
                        await updateWorkplaceKeywords(selected, true); // silent = true（アラートなし）
                        setAskWorkplaceName(false);
                        // 自動的に登録プロセスを開始
                        setTimeout(() => {
                          setShowOverwriteDialog(true);
                        }, 100);
                      }
                    }
                  }}
                  disabled={!selectedWorkplaceId}
                >
                  この店を選択
                </button>
                <button 
                  className="btn secondary" 
                  onClick={() => {
                    setIsNewWorkplace(true);
                    setSelectedWorkplaceId('');
                  }}
                >
                  ＋ 新しいバイト先
                </button>
              </div>
            </>
          ) : (
            // 新しいバイト先を登録
            <>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 14 }}>
                バイト先名を入力してください。次回から、この画像の特徴を自動で判別できるようになります。
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                <input
                  className="input"
                  type="text"
                  placeholder="例: JR尼崎店"
                  value={workplaceNameInput}
                  onChange={(e) => setWorkplaceNameInput(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  className="btn" 
                  onClick={async () => {
                    if (workplaceNameInput.trim()) {
                      const newWorkplaceName = workplaceNameInput.trim();
                      setSelectedWorkplaceName(newWorkplaceName); // バイト先名を保存
                      
                      // イベントのタイトルをバイト先名で更新（プレビュー用）
                      if (events && events.length > 0) {
                        const updatedEvents = events.map(e => ({
                          ...e,
                          title: newWorkplaceName
                        }));
                        setEvents(updatedEvents);
                        console.log('[OCR] Updated event titles to:', newWorkplaceName);
                      }
                      
                      await saveWorkplaceProfile();
                      console.log('[OCR] New workplace profile saved:', newWorkplaceName);
                      setAskWorkplaceName(false);
                      // 自動的に登録プロセスを開始
                      setTimeout(() => {
                        setShowOverwriteDialog(true);
                      }, 100);
                    }
                  }}
                  disabled={!workplaceNameInput.trim()}
                >
                  記憶して登録
                </button>
                {existingWorkplaces.length > 0 && (
                  <button 
                    className="btn secondary" 
                    onClick={() => {
                      setIsNewWorkplace(false);
                      setWorkplaceNameInput('');
                    }}
                  >
                    ← 既存のバイト先から選択
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {events && events.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>抽出結果（{events.length}件）</h3>
            <select
              className="input"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{ padding: '6px 12px', fontSize: 14 }}
            >
              <option value="date">日付順</option>
              <option value="title">タイトル順</option>
            </select>
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            {sortedEvents.map((ev, i) => {
              const originalIdx = events.findIndex((e) => e === ev);
              return (
                <div key={i} className="card" style={{ padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <IconDocument />
                      <h4 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
                        {ev.title || '（タイトル未設定）'}
                      </h4>
                    </div>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        const single = [ev];
                        addEventsBulk(single).then(() => {
                          alert('カレンダーに追加しました');
                        }).catch((e) => alert(e?.message ?? '追加に失敗しました'));
                      }}
                      style={{ fontSize: 14, padding: '6px 12px' }}
                    >
                      カレンダーに追加
                    </button>
                  </div>

                  <div style={{ display: 'grid', gap: 8, color: 'var(--text-secondary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <IconClock />
                      <span style={{ fontWeight: 500 }}>開始:</span>
                      <span>{formatDateTime(ev.start_time)}</span>
                    </div>
                    {ev.end_time && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <IconClock />
                        <span style={{ fontWeight: 500 }}>終了:</span>
                        <span>{formatDateTime(ev.end_time)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <IconCalendar />
                      <span style={{ fontWeight: 500 }}>カテゴリ:</span>
                      <span>{categoryLabel[ev.category] || 'その他'}</span>
                    </div>
                    
                    {/* 給与情報表示 */}
                    {ev.estimated_salary !== undefined && ev.estimated_salary !== null && (
                      <div style={{ 
                        marginTop: 12, 
                        padding: 12, 
                        background: '#d1fae5', 
                        borderRadius: 6,
                        border: '1px solid #10b981'
                      }}>
                        <div style={{ 
                          fontSize: 16, 
                          fontWeight: 600, 
                          color: '#047857',
                          marginBottom: 4
                        }}>
                          予測給与: {ev.estimated_salary.toLocaleString()}円
                        </div>
                        {ev.salary_breakdown && (
                          <details style={{ fontSize: 12, color: '#059669', marginTop: 8 }}>
                            <summary style={{ cursor: 'pointer' }}>内訳を表示</summary>
                            <div style={{ marginTop: 8, whiteSpace: 'pre-line', fontFamily: 'monospace' }}>
                              {ev.salary_breakdown.join('\n')}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </div>

                  <details style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 14 }}>詳細を編集</summary>
                    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>タイトル</span>
                        <input
                          className="input"
                          value={ev.title}
                          onChange={(e) => updateEvent(originalIdx, { title: e.target.value })}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>開始日時 (ISO)</span>
                        <input
                          className="input"
                          value={ev.start_time}
                          onChange={(e) => updateEvent(originalIdx, { start_time: e.target.value })}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>終了日時 (ISO)</span>
                        <input
                          className="input"
                          value={ev.end_time ?? ''}
                          onChange={(e) => updateEvent(originalIdx, { end_time: e.target.value })}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>カテゴリ</span>
                        <select
                          className="input"
                          value={ev.category}
                          onChange={(e) => updateEvent(originalIdx, { category: e.target.value as any })}
                        >
                          <option value="work_study">仕事・勉強</option>
                          <option value="life_chores">生活・雑務</option>
                          <option value="leisure">余暇</option>
                          <option value="other">その他</option>
                        </select>
                      </label>
                    </div>
                  </details>
                </div>
              );
            })}
          </div>

          {/* 上書き確認ダイアログ */}
          {showOverwriteDialog && dateRange && (
            <div style={{ 
              position: 'fixed', 
              top: 0, 
              left: 0, 
              right: 0, 
              bottom: 0, 
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000
            }}>
              <div className="card" style={{ 
                maxWidth: 500,
                padding: 24,
                background: 'white'
              }}>
                <h3 style={{ marginTop: 0 }}>シフトの上書き確認</h3>
                <p style={{ color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
                  抽出した期間（{formatDateTime(dateRange.start)} 〜 {formatDateTime(dateRange.end)}）について、
                  カレンダー上の既存の「バイト」予定を削除し、今回の内容（{events?.length ?? 0}件）で上書きしますか？
                  <br /><br />
                  <strong>※ 既存の予定が削除されます。</strong>
                </p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                  <button className="btn secondary" onClick={cancelOverwrite} disabled={loading}>
                    キャンセル
                  </button>
                  <button className="btn" onClick={confirmOverwrite} disabled={loading}>
                    {loading ? '登録中...' : '上書きする'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="btn" onClick={saveAll} disabled={loading || saved}>
              {saved ? '登録済み' : 'すべて登録'}
            </button>
            {saved && (
              <span style={{ color: '#16a34a', fontSize: 14 }}>すべての予定をカレンダーに登録しました。</span>
            )}
          </div>
        </div>
      )}

      {/* 学校時間割の対話中 */}
      {console.log('[OCR Page Render] schoolLearningInProgress:', schoolLearningInProgress)}
      {console.log('[OCR Page Render] schoolClasses.length:', schoolClasses.length)}
      {schoolLearningInProgress && (
        <div className="card" style={{ marginBottom: 24, background: '#eff6ff', borderColor: '#3b82f6' }}>
          <h3 style={{ marginTop: 0, color: '#1e40af' }}>時間割を学習中</h3>
          
          {/* 解析された時間割プレビュー（編集可能） */}
          <div style={{ marginBottom: 16, padding: 14, background: '#d1fae5', borderRadius: 8, border: '1px solid #10b981' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: 14, color: '#047857' }}>
              {schoolClasses.length > 0 ? '解析された時間割（クリックで編集）' : '時間割を手動で作成'}
            </h4>
            
            {schoolClasses.length === 0 && (
              <p style={{ fontSize: 12, color: '#065f46', marginBottom: 12 }}>
                AIが時間割を解析できませんでした。下の「+ 授業を追加」ボタンで、各曜日の授業を手動で追加してください。
              </p>
            )}
              <div style={{ 
                maxHeight: 500, 
                overflowY: 'auto',
                overflowX: 'auto',
                fontSize: 12
              }}>
                {/* 時間割テーブル（縦：時限、横：曜日） */}
                {(() => {
                  const days = ['月', '火', '水', '木', '金'];
                  const maxPeriod = schoolClasses.length > 0 
                    ? Math.max(...schoolClasses.map((c: any) => c.period), 6)
                    : 6;
                  const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1);
                  
                  return (
                    <table style={{ 
                      width: '100%', 
                      tableLayout: 'fixed',
                      borderCollapse: 'collapse',
                      backgroundColor: 'white',
                      minWidth: 600
                    }}>
                      <colgroup>
                        <col style={{ width: 60 }} />
                        <col style={{ width: 110 }} />
                        <col style={{ width: 'calc((100% - 170px) / 5)' }} />
                        <col style={{ width: 'calc((100% - 170px) / 5)' }} />
                        <col style={{ width: 'calc((100% - 170px) / 5)' }} />
                        <col style={{ width: 'calc((100% - 170px) / 5)' }} />
                        <col style={{ width: 'calc((100% - 170px) / 5)' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th style={{ 
                            border: '1px solid #d1d5db', 
                            padding: '8px 4px',
                            backgroundColor: '#f3f4f6',
                            fontSize: 11,
                            fontWeight: 600,
                            textAlign: 'center'
                          }}>時限</th>
                          <th style={{ 
                            border: '1px solid #d1d5db', 
                            padding: '8px 4px',
                            backgroundColor: '#f3f4f6',
                            fontSize: 11,
                            fontWeight: 600,
                            textAlign: 'center'
                          }}>時間</th>
                          {days.map(day => (
                            <th key={day} style={{ 
                              border: '1px solid #d1d5db', 
                              padding: '8px 4px',
                              backgroundColor: '#f3f4f6',
                              fontSize: 12,
                              fontWeight: 600,
                              textAlign: 'center'
                            }}>{day}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {periods.map(period => {
                          // この時限の時間を取得（どの曜日でも良いので最初に見つかったもの）
                          const classWithTime = schoolClasses.find((c: any) => c.period === period);
                          
                          // この時限の授業時間をschoolFormData.timingsから取得
                          const timing = schoolFormData.timings?.find(t => t.period === period);
                          const startTime = classWithTime?.start_time || timing?.start || '';
                          const endTime = classWithTime?.end_time || timing?.end || '';
                          
                          return (
                            <tr key={period}>
                              <td style={{ 
                                border: '1px solid #d1d5db', 
                                padding: 6,
                                textAlign: 'center',
                                fontSize: 12,
                                fontWeight: 600,
                                color: '#065f46',
                                backgroundColor: '#f9fafb'
                              }}>{period}限</td>
                              <td style={{ 
                                border: '1px solid #d1d5db', 
                                padding: 4,
                                textAlign: 'center',
                                fontSize: 10,
                                color: '#6b7280',
                                backgroundColor: '#f9fafb',
                                verticalAlign: 'middle'
                              }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                                    <input
                                      type="time"
                                      value={startTime}
                                      onChange={(e) => {
                                        // この時限の全ての授業の開始時刻を更新
                                        const updated = schoolClasses.map(cls => 
                                          cls.period === period 
                                            ? { ...cls, start_time: e.target.value }
                                            : cls
                                        );
                                        setSchoolClasses(updated);
                                        
                                        // schoolFormData.timingsも更新
                                        const updatedTimings = schoolFormData.timings.map(t =>
                                          t.period === period ? { ...t, start: e.target.value } : t
                                        );
                                        setSchoolFormData({ ...schoolFormData, timings: updatedTimings });
                                      }}
                                      style={{
                                        padding: '2px 4px',
                                        fontSize: 10,
                                        border: '1px solid #d1d5db',
                                        borderRadius: 3,
                                        width: 80
                                      }}
                                    />
                                  </div>
                                  <span style={{ fontSize: 9, color: '#9ca3af' }}>〜</span>
                                  <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                                    <input
                                      type="time"
                                      value={endTime}
                                      onChange={(e) => {
                                        // この時限の全ての授業の終了時刻を更新
                                        const updated = schoolClasses.map(cls => 
                                          cls.period === period 
                                            ? { ...cls, end_time: e.target.value }
                                            : cls
                                        );
                                        setSchoolClasses(updated);
                                        
                                        // schoolFormData.timingsも更新
                                        const updatedTimings = schoolFormData.timings.map(t =>
                                          t.period === period ? { ...t, end: e.target.value } : t
                                        );
                                        setSchoolFormData({ ...schoolFormData, timings: updatedTimings });
                                      }}
                                      style={{
                                        padding: '2px 4px',
                                        fontSize: 10,
                                        border: '1px solid #d1d5db',
                                        borderRadius: 3,
                                        width: 80
                                      }}
                                    />
                                  </div>
                                </div>
                              </td>
                              {days.map(day => {
                                const cls = schoolClasses.find((c: any) => 
                                  c.day_of_week === day && c.period === period
                                );
                                const globalIdx = cls ? schoolClasses.findIndex((c: any) => 
                                  c.day_of_week === day && 
                                  c.period === period && 
                                  c.subject === cls.subject
                                ) : -1;
                                
                                return (
                                  <td key={day} style={{ 
                                    border: '1px solid #d1d5db', 
                                    padding: 4,
                                    verticalAlign: 'top',
                                    minHeight: 60,
                                    overflow: 'hidden'
                                  }}>
                                    {cls ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                        <input
                                          type="text"
                                          value={cls.subject}
                                          onChange={(e) => {
                                            const updated = [...schoolClasses];
                                            updated[globalIdx].subject = e.target.value;
                                            setSchoolClasses(updated);
                                          }}
                                          style={{
                                            width: '100%',
                                            padding: '4px 6px',
                                            fontSize: 11,
                                            border: '1px solid #d1d5db',
                                            borderRadius: 3,
                                            fontWeight: 500
                                          }}
                                          placeholder="科目名"
                                        />
                                        {cls.teacher && (
                                          <input
                                            type="text"
                                            value={cls.teacher}
                                            onChange={(e) => {
                                              const updated = [...schoolClasses];
                                              updated[globalIdx].teacher = e.target.value;
                                              setSchoolClasses(updated);
                                            }}
                                            style={{
                                              width: '100%',
                                              padding: '3px 6px',
                                              fontSize: 10,
                                              border: '1px solid #e5e7eb',
                                              borderRadius: 3,
                                              color: '#6b7280'
                                            }}
                                            placeholder="担当者"
                                          />
                                        )}
                                        <button
                                          onClick={() => {
                                            const updated = schoolClasses.filter((_, i) => i !== globalIdx);
                                            setSchoolClasses(updated);
                                          }}
                                          style={{
                                            padding: '2px 6px',
                                            fontSize: 9,
                                            background: '#fee2e2',
                                            color: '#991b1b',
                                            border: '1px solid #fecaca',
                                            borderRadius: 3,
                                            cursor: 'pointer'
                                          }}
                                        >
                                          削除
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          // その時限の時間をschoolFormData.timingsから取得
                                          const timing = schoolFormData.timings?.find(t => t.period === period);
                                          const newClass = {
                                            day_of_week: day,
                                            period: period,
                                            start_time: timing?.start || '',
                                            end_time: timing?.end || '',
                                            subject: '',
                                            teacher: ''
                                          };
                                          setSchoolClasses([...schoolClasses, newClass]);
                                        }}
                                        style={{
                                          width: '100%',
                                          padding: '6px 4px',
                                          fontSize: 10,
                                          background: '#f9fafb',
                                          color: '#9ca3af',
                                          border: '1px dashed #d1d5db',
                                          borderRadius: 3,
                                          cursor: 'pointer'
                                        }}
                                      >
                                        + 追加
                                      </button>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
              {schoolClasses.length > 0 && (
                <p style={{ fontSize: 11, color: '#065f46', marginTop: 10, marginBottom: 0 }}>
                  AI が時間割を解析しました。誤りがあれば直接編集でき、不足している授業は「+ 授業を追加」ボタンで追加できます。
                </p>
              )}
            </div>
          
          {/* OCR読み取り結果 */}
          {schoolOcrText && (
            <details style={{ marginBottom: 16, padding: 12, background: '#f3f4f6', borderRadius: 8, border: '1px solid #d1d5db' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: '#374151' }}>
                読み取ったテキストを表示（デバッグ用）
              </summary>
              <div style={{ 
                marginTop: 12, 
                padding: 10, 
                background: 'white', 
                borderRadius: 6,
                fontSize: 12,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                color: '#1f2937',
                maxHeight: 200,
                overflowY: 'auto'
              }}>
                {schoolOcrText}
              </div>
              <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8, marginBottom: 0 }}>
                ※ OCRで読み取れなかった部分や誤認識がある場合は、以下のチャットで修正できます。
              </p>
            </details>
          )}
          
          {/* 会話履歴 */}
          {schoolConversation.length > 0 && (
            <div style={{ 
              maxHeight: 300, 
              overflowY: 'auto', 
              marginBottom: 16,
              padding: 12,
              background: 'white',
              borderRadius: 8,
              border: '1px solid #e5e7eb'
            }}>
              {schoolConversation.map((msg, idx) => (
                <div 
                  key={idx} 
                  style={{ 
                    marginBottom: 12,
                    padding: 10,
                    borderRadius: 8,
                    background: msg.role === 'user' ? '#eaf2ff' : '#f3f4f6',
                    borderLeft: msg.role === 'user' ? '3px solid #3b82f6' : '3px solid #6b7280'
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: msg.role === 'user' ? '#1e40af' : '#4b5563' }}>
                    {msg.role === 'user' ? 'あなた' : 'AI'}
                  </div>
                  <div style={{ fontSize: 13, whiteSpace: 'pre-line' }}>
                    {msg.content}
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {/* 学校情報入力フォーム */}
          <div style={{ 
            padding: 16, 
            background: 'white', 
            borderRadius: 8, 
            border: '2px solid #3b82f6',
            marginBottom: 16
          }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 15, color: '#1e40af' }}>
              学校情報を入力してください
            </h4>
            
            {/* 自動復元メッセージ */}
            {schoolFormData.schoolName && (
              <div style={{
                padding: 8,
                marginBottom: 12,
                background: '#d1fae5',
                borderRadius: 6,
                border: '1px solid #10b981',
                fontSize: 12,
                color: '#047857'
              }}>
                ✓ 前回の学校情報「{schoolFormData.schoolName}」を読み込みました。変更がある場合は編集してください。
              </div>
            )}
            
            {/* デバッグ情報 */}
            <div style={{ 
              fontSize: 11, 
              color: '#6b7280', 
              marginBottom: 12,
              padding: 8,
              background: '#f9fafb',
              borderRadius: 4
            }}>
              時間割データ: {schoolClasses.length}コマ読み込み済み
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 学校名 */}
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  学校名（必須）
                </label>
                <input
                  type="text"
                  className="input"
                  value={schoolFormData.schoolName}
                  onChange={(e) => setSchoolFormData({ ...schoolFormData, schoolName: e.target.value })}
                  placeholder="例: 慶應義塾大学 環境情報学部"
                  style={{ width: '100%' }}
                />
              </div>
              
              {/* 祝日ルール */}
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  祝日の授業
                </label>
                <select
                  className="input"
                  value={schoolFormData.holidayRule}
                  onChange={(e) => setSchoolFormData({ ...schoolFormData, holidayRule: e.target.value })}
                  style={{ width: '100%' }}
                >
                  <option value="">選択してください</option>
                  <option value="OFF">休講</option>
                  <option value="ON">通常通り</option>
                </select>
              </div>
              
              {/* 夏休み */}
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  夏休み期間（任意）
                </label>
                <input
                  type="text"
                  className="input"
                  value={schoolFormData.summerVacation}
                  onChange={(e) => setSchoolFormData({ ...schoolFormData, summerVacation: e.target.value })}
                  placeholder="例: 8月1日 ～ 9月20日"
                  style={{ width: '100%' }}
                />
              </div>
              
              {/* 冬休み */}
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  冬休み期間（任意）
                </label>
                <input
                  type="text"
                  className="input"
                  value={schoolFormData.winterVacation}
                  onChange={(e) => setSchoolFormData({ ...schoolFormData, winterVacation: e.target.value })}
                  placeholder="例: 12月25日 ～ 1月7日"
                  style={{ width: '100%' }}
                />
              </div>
              
              {/* 春休み */}
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  春休み期間（任意）
                </label>
                <input
                  type="text"
                  className="input"
                  value={schoolFormData.springVacation}
                  onChange={(e) => setSchoolFormData({ ...schoolFormData, springVacation: e.target.value })}
                  placeholder="例: 2月15日 ～ 4月5日"
                  style={{ width: '100%' }}
                />
              </div>
              
              {/* 保存ボタン */}
              <button
                className="btn"
                onClick={submitSchoolForm}
                disabled={loading || !schoolFormData.schoolName.trim()}
                style={{ marginTop: 8 }}
              >
                {loading ? '保存中...' : '学校情報を保存して登録完了'}
              </button>
            </div>
          </div>
          
          {/* やり直しボタン */}
          <button
            className="btn secondary"
            onClick={() => {
              setSchoolLearningInProgress(false);
              setSchoolConversation([]);
              setSchoolContext(null);
              setSchoolOcrText('');
              setSchoolClasses([]);
              setSchoolFormData({
                schoolName: '',
                holidayRule: '',
                summerVacation: '',
                winterVacation: '',
                springVacation: '',
                timings: [
                  { period: 1, start: '09:20', end: '10:10' },
                  { period: 2, start: '10:20', end: '11:10' },
                  { period: 3, start: '11:20', end: '12:10' },
                  { period: 4, start: '13:10', end: '14:00' },
                  { period: 5, start: '14:10', end: '15:00' },
                  { period: 6, start: '15:10', end: '16:00' }
                ]
              });
              setFiles([]);
              setFile(null);
            }}
            style={{ width: '100%', fontSize: 13 }}
          >
            写真を撮り直す
          </button>
        </div>
      )}

      {/* 学校時間割登録成功メッセージ */}
      {schoolLearningSuccess && (
        <div className="card" style={{ background: '#d1fae5', borderColor: '#10b981', marginBottom: 24 }}>
          <h3 style={{ marginTop: 0, color: '#047857' }}>時間割の登録が完了しました！</h3>
          
          {/* 登録された授業数 */}
          {schoolClasses.length > 0 && (
            <div style={{ 
              padding: 12, 
              background: 'white', 
              borderRadius: 6,
              marginBottom: 12,
              border: '1px solid #86efac'
            }}>
              <div style={{ fontSize: 13, color: '#065f46', marginBottom: 8 }}>
                <strong>{schoolClasses.length}コマ</strong> の授業をカレンダーに登録しました
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {['月', '火', '水', '木', '金'].map(day => {
                  const count = schoolClasses.filter((c: any) => c.day_of_week === day).length;
                  return count > 0 ? `${day}: ${count}コマ` : null;
                }).filter(Boolean).join(' / ')}
              </div>
            </div>
          )}
          
          <p style={{ marginBottom: 12, color: '#065f46', fontSize: 14 }}>
            学校の時間割をAIMOが学習しました。カレンダーページで授業予定を確認できます。
          </p>
          
          <div style={{ display: 'flex', gap: 8 }}>
            <button 
              className="btn" 
              onClick={() => {
                window.location.href = '/calendar';
              }}
              style={{ flex: 1 }}
            >
              カレンダーで確認
            </button>
            <button 
              className="btn secondary" 
              onClick={() => {
                setSchoolLearningSuccess(false);
                setSchoolConversation([]);
                setSchoolContext(null);
                setSchoolOcrText('');
                setSchoolClasses([]);
                setSchoolFormData({
                  schoolName: '',
                  holidayRule: '',
                  summerVacation: '',
                  winterVacation: '',
                  springVacation: '',
                  timings: [
                    { period: 1, start: '09:20', end: '10:10' },
                    { period: 2, start: '10:20', end: '11:10' },
                    { period: 3, start: '11:20', end: '12:10' },
                    { period: 4, start: '13:10', end: '14:00' },
                    { period: 5, start: '14:10', end: '15:00' },
                    { period: 6, start: '15:10', end: '16:00' }
                  ]
                });
                setFiles([]);
                setFile(null);
              }}
              style={{ flex: 1 }}
            >
              別の時間割を登録
            </button>
          </div>
        </div>
      )}

      {/* 登録完了アニメーション */}
      {showSuccessAnimation && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000,
          animation: 'fadeIn 0.3s ease-out'
        }}>
          <div style={{
            background: 'white',
            borderRadius: 24,
            padding: 48,
            textAlign: 'center',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            animation: 'scaleIn 0.4s ease-out'
          }}>
            <div style={{
              fontSize: 80,
              color: '#16a34a',
              animation: 'bounce 0.6s ease-out'
            }}>
              OK
            </div>
            <div style={{
              fontSize: 24,
              fontWeight: 600,
              color: '#16a34a',
              marginTop: 16
            }}>
              登録完了！
            </div>
            <div style={{
              fontSize: 14,
              color: 'var(--text-secondary)',
              marginTop: 8
            }}>
              カレンダーに追加されました
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
